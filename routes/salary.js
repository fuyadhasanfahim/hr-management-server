// salaryRoute.js
require('dotenv').config();
const express = require('express');
const moment = require('moment-timezone');
const { client } = require('../lib/db');

const salaryRoute = express.Router();

const db = client.db('hrManagement');
const PFAndSalaryCollections = db.collection('PFAndSalaryList');
const attendanceCollections = db.collection('attendanceList');
const employeeCollections = db.collection('employeeList');
const shiftingCollections = db.collection('shiftingList');
const workingShiftCollections = db.collection('workingShiftList');
const leaveCollections = db.collection('appliedLeaveList');

const MONTHS = [
    'january',
    'february',
    'march',
    'april',
    'may',
    'june',
    'july',
    'august',
    'september',
    'october',
    'november',
    'december',
];

// JS helper: convert many date string formats to a moment (Asia/Dhaka), day-start
function parseToMoment(dateStr) {
    if (!dateStr) return null;
    const formats = [
        'DD-MMM-YYYY',
        'D-MMM-YYYY',
        'YYYY-MM-DD',
        'DD-MM-YYYY',
        'D-M-YYYY',
    ];
    for (const f of formats) {
        const m = moment.tz(dateStr, f, 'Asia/Dhaka');
        if (m.isValid()) return m.startOf('day');
    }
    // fallback to generic parser
    const m2 = moment.tz(dateStr, 'Asia/Dhaka');
    return m2.isValid() ? m2.startOf('day') : null;
}

// JS helper: count occurrences of given weekday names in a month
function countWeekendDays(year, monthIndex, weekendNames = []) {
    if (!Array.isArray(weekendNames) || weekendNames.length === 0) return 0;
    const nameMap = {
        sunday: 0,
        monday: 1,
        tuesday: 2,
        wednesday: 3,
        thursday: 4,
        friday: 5,
        saturday: 6,
    };
    const nums = weekendNames
        .map((s) =>
            String(s || '')
                .trim()
                .toLowerCase()
        )
        .map((s) => nameMap[s])
        .filter((n) => typeof n === 'number');
    if (!nums.length) return 0;
    const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
    let cnt = 0;
    for (let d = 1; d <= daysInMonth; d++) {
        const dt = new Date(year, monthIndex, d);
        if (nums.includes(dt.getDay())) cnt++;
    }
    return cnt;
}

salaryRoute.get('/get-salary-sheet', async (req, res) => {
    try {
        let { search = '', month = '', page = 1, limit = 20 } = req.query;
        if (!month)
            return res.status(400).json({
                message: 'month query required (e.g. ?month=October)',
            });

        search = String(search || '')
            .trim()
            .toLowerCase();
        month = String(month || '')
            .trim()
            .toLowerCase();

        const monthIndex = MONTHS.indexOf(month);
        if (monthIndex === -1)
            return res.status(400).json({ message: 'Invalid month name' });

        const year = new Date().getFullYear();
        const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();

        page = Math.max(1, Number(page) || 1);
        limit = Math.max(1, Number(limit) || 20);
        const skip = (page - 1) * limit;

        const ignoredEmails = (process.env.IGNORED_ATTENDANCE_EMAILS || '')
            .split(',')
            .map((e) => e.trim().toLowerCase())
            .filter(Boolean);

        // Build PF match
        const pfMatch = {};
        if (search) pfMatch.email = { $regex: search, $options: 'i' };

        // Build month patterns for attendance lookup:
        // 1) ISO-style "YYYY-MM" prefix (e.g. "2025-10-")
        // 2) Short-month style "-Oct-YYYY" (e.g. "15-Oct-2025")
        const isoPrefix = `${year}-${String(monthIndex + 1).padStart(2, '0')}`; // e.g. "2025-10"
        // short month like "Oct"
        const monthShort = moment.monthsShort()[monthIndex]; // e.g. "Oct"
        const shortMonthRegex = `-${monthShort}-${year}`; // e.g. "-Oct-2025"

        // Aggregation pipeline: join PF -> employee -> shifting -> workingShift -> attendance month -> approved leaves
        const pipeline = [
            { $match: pfMatch },

            // join employee
            {
                $lookup: {
                    from: 'employeeList',
                    localField: 'email',
                    foreignField: 'email',
                    as: 'emp',
                },
            },
            { $unwind: '$emp' },
            { $match: { 'emp.status': { $ne: 'De-activate' } } },

            // join shiftingList (employee assigned shift)
            {
                $lookup: {
                    from: 'shiftingList',
                    let: { email: '$email' },
                    pipeline: [
                        { $match: { $expr: { $eq: ['$email', '$$email'] } } },
                        { $limit: 1 },
                    ],
                    as: 'shiftAssign',
                },
            },
            {
                $addFields: {
                    shiftAssign: { $arrayElemAt: ['$shiftAssign', 0] },
                },
            },

            // join workingShiftList as fallback (by shiftName+branch)
            {
                $lookup: {
                    from: 'workingShiftList',
                    let: {
                        shiftName: '$shiftAssign.shiftName',
                        branch: '$shiftAssign.branch',
                    },
                    pipeline: [
                        {
                            $match: {
                                $expr: {
                                    $and: [
                                        { $ifNull: ['$$shiftName', false] },
                                        { $eq: ['$shiftName', '$$shiftName'] },
                                        { $eq: ['$branch', '$$branch'] },
                                    ],
                                },
                            },
                        },
                        { $limit: 1 },
                    ],
                    as: 'workingShift',
                },
            },
            {
                $addFields: {
                    workingShift: { $arrayElemAt: ['$workingShift', 0] },
                },
            },

            // attendance lookup for the target month (match either isoPrefix or -Mon-YYYY)
            {
                $lookup: {
                    from: 'attendanceList',
                    let: { email: '$email' },
                    pipeline: [
                        {
                            $match: {
                                $expr: {
                                    $and: [
                                        { $eq: ['$email', '$$email'] },
                                        {
                                            $or: [
                                                {
                                                    $regexMatch: {
                                                        input: '$date',
                                                        regex: `^${isoPrefix}`,
                                                    },
                                                },
                                                {
                                                    $regexMatch: {
                                                        input: '$date',
                                                        regex: `${shortMonthRegex}`,
                                                    },
                                                },
                                            ],
                                        },
                                    ],
                                },
                            },
                        },
                        // group dedupe days
                        {
                            $group: {
                                _id: null,
                                dates: { $addToSet: '$date' },
                            },
                        },
                        {
                            $project: {
                                _id: 0,
                                dates: 1,
                                attendanceCount: {
                                    $size: { $ifNull: ['$dates', []] },
                                },
                            },
                        },
                    ],
                    as: 'attendanceMonth',
                },
            },
            {
                $addFields: {
                    attendanceMonth: { $arrayElemAt: ['$attendanceMonth', 0] },
                },
            },

            // approved leave lookup for user (we fetch approved leaves; counting done in JS)
            {
                $lookup: {
                    from: 'appliedLeaveList',
                    let: { email: '$email' },
                    pipeline: [
                        {
                            $match: {
                                $expr: {
                                    $and: [
                                        { $eq: ['$email', '$$email'] },
                                        { $eq: ['$status', 'Approved'] },
                                    ],
                                },
                            },
                        },
                        {
                            $project: {
                                startDate: 1,
                                endDate: 1,
                                grantedDates: 1,
                            },
                        },
                    ],
                    as: 'approvedLeaves',
                },
            },

            // project only required fields
            {
                $project: {
                    email: 1,
                    salary: 1,
                    emp: {
                        fullName: '$emp.fullName',
                        accountNumber: '$emp.accountNumber',
                    },
                    shiftAssign: 1,
                    workingShift: 1,
                    attendanceMonth: 1,
                    approvedLeaves: 1,
                },
            },

            // pagination
            { $skip: skip },
            { $limit: limit },
        ];

        const agg = await PFAndSalaryCollections.aggregate(pipeline).toArray();

        // Prepare month boundaries
        const monthStart = moment
            .tz(
                `${year}-${String(monthIndex + 1).padStart(2, '0')}-01`,
                'YYYY-MM-DD',
                'Asia/Dhaka'
            )
            .startOf('day');
        const monthEnd = monthStart.clone().endOf('month');

        const rows = [];

        for (const d of agg) {
            const email = String(d.email || '').toLowerCase();
            const emp = d.emp || {};
            const salary = Number(d.salary || 0);

            // ignored full-salary
            const ignored = (process.env.IGNORED_ATTENDANCE_EMAILS || '')
                .split(',')
                .map((e) => e.trim().toLowerCase())
                .filter(Boolean)
                .includes(email);
            if (ignored) {
                const perDay = Number((salary / daysInMonth).toFixed(2));
                rows.push({
                    email,
                    name: emp.fullName || '',
                    accountNumber: emp.accountNumber || '',
                    salary,
                    perDaySalary: perDay,
                    present: 0,
                    absent: 0,
                    total: salary,
                });
                continue;
            }

            const attendanceCount =
                d.attendanceMonth && d.attendanceMonth.attendanceCount
                    ? d.attendanceMonth.attendanceCount
                    : 0;

            // determine weekends: shiftAssign.weekends > workingShift.weekends > default ['Sunday']
            let weekends = [];
            if (
                d.shiftAssign &&
                Array.isArray(d.shiftAssign.weekends) &&
                d.shiftAssign.weekends.length
            ) {
                weekends = d.shiftAssign.weekends;
            } else if (
                d.workingShift &&
                Array.isArray(d.workingShift.weekends) &&
                d.workingShift.weekends.length
            ) {
                weekends = d.workingShift.weekends;
            } else {
                weekends = ['Sunday']; // default as requested
            }

            const weekendCount = countWeekendDays(year, monthIndex, weekends);

            // compute granted leave count inside month (robust parsing)
            let grantedLeaveCount = 0;
            for (const leave of d.approvedLeaves || []) {
                if (
                    Array.isArray(leave.grantedDates) &&
                    leave.grantedDates.length
                ) {
                    for (const dstr of leave.grantedDates) {
                        const m = parseToMoment(dstr);
                        if (!m) continue;
                        if (m.isBetween(monthStart, monthEnd, 'day', '[]'))
                            grantedLeaveCount++;
                    }
                } else {
                    const sd = parseToMoment(leave.startDate);
                    const ed = parseToMoment(leave.endDate);
                    if (!sd || !ed) continue;
                    const from = moment.max(sd, monthStart);
                    const to = moment.min(ed, monthEnd);
                    if (to.isSameOrAfter(from)) {
                        grantedLeaveCount += to.diff(from, 'days') + 1;
                    }
                }
            }

            let present = attendanceCount + weekendCount + grantedLeaveCount;
            if (present > daysInMonth) present = daysInMonth;
            let absent = daysInMonth - present;
            if (absent < 0) absent = 0;

            const perDaySalary = Number((salary / daysInMonth).toFixed(2));
            const total = Math.ceil(present * perDaySalary);

            rows.push({
                email,
                name: emp.fullName || '',
                accountNumber: emp.accountNumber || '',
                salary,
                perDaySalary,
                present,
                absent,
                total,
                _debug: {
                    attendanceCount,
                    weekendCount,
                    grantedLeaveCount,
                    weekends,
                }, // optional debug
            });
        }

        // compute totalEmployees for pagination (matching PFs with active employees)
        const countPipeline = [
            { $match: pfMatch },
            {
                $lookup: {
                    from: 'employeeList',
                    localField: 'email',
                    foreignField: 'email',
                    as: 'emp',
                },
            },
            { $unwind: '$emp' },
            { $match: { 'emp.status': { $ne: 'De-activate' } } },
            { $count: 'total' },
        ];
        const countAgg = await PFAndSalaryCollections.aggregate(
            countPipeline
        ).toArray();
        const totalEmployees = countAgg[0]?.total || 0;

        return res.json({
            page,
            limit,
            totalEmployees,
            totalPages: Math.ceil(totalEmployees / limit),
            data: rows,
        });
    } catch (err) {
        console.error('salary sheet error', err);
        return res
            .status(500)
            .json({ message: 'Internal Server Error', error: err.message });
    }
});

module.exports = { salaryRoute };
