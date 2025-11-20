// salaryRoute.aggregate.js
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
const leaveCollections = db.collection('appliedLeaveList'); // your uploaded: /mnt/data/hrManagement.appliedLeaveList.json

const MONTHS = [
    'january','february','march','april','may','june',
    'july','august','september','october','november','december'
];

// helper to count weekend occurrences in a month (JS)
function countWeekendDaysJS(year, monthIndex, weekendNames = []) {
    if (!Array.isArray(weekendNames) || weekendNames.length === 0) return 0;
    // js Date.getDay(): 0=Sunday ... 6=Saturday
    const wk = weekendNames
        .map(w => (String(w || '').trim().toLowerCase()))
        .filter(Boolean);

    const nameToNum = {
        sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
        thursday: 4, friday: 5, saturday: 6
    };

    const weekendNums = wk.map(n => nameToNum[n]).filter(n => typeof n === 'number');

    let count = 0;
    const totalDays = new Date(year, monthIndex + 1, 0).getDate();
    for (let d = 1; d <= totalDays; d++) {
        const dt = new Date(year, monthIndex, d);
        if (weekendNums.includes(dt.getDay())) count++;
    }
    return count;
}

// parse a granted date string robustly into a moment in Asia/Dhaka
function parseGrantedDateToMoment(str) {
    if (!str) return null;
    // try common formats used in your data: "21-Nov-2025", "2025-11-21", etc.
    const fmts = ['DD-MMM-YYYY', 'D-MMM-YYYY', 'YYYY-MM-DD', 'DD-MM-YYYY', 'D-M-YYYY'];
    for (const f of fmts) {
        const m = moment.tz(str, f, 'Asia/Dhaka');
        if (m.isValid()) return m.startOf('day');
    }
    // fallback safe parse
    const m2 = moment.tz(str, 'Asia/Dhaka');
    return m2.isValid() ? m2.startOf('day') : null;
}

salaryRoute.get('/get-salary-sheet', async (req, res) => {
    try {
        let { search = '', month = '', page = 1, limit = 20 } = req.query;

        if (!month) return res.status(400).json({ message: 'month query is required (e.g. ?month=October)' });

        search = String(search || '').trim().toLowerCase();
        month = String(month || '').trim().toLowerCase();

        const monthIndex = MONTHS.indexOf(month);
        if (monthIndex === -1) return res.status(400).json({ message: 'Invalid month name' });

        const year = new Date().getFullYear();
        const totalDaysInMonth = new Date(year, monthIndex + 1, 0).getDate();

        page = Math.max(1, Number(page) || 1);
        limit = Math.max(1, Number(limit) || 20);
        const skip = (page - 1) * limit;

        // ignored emails (env) - comma separated
        const ignoredEmails = (process.env.IGNORED_ATTENDANCE_EMAILS || '')
            .split(',')
            .map(e => e.trim().toLowerCase())
            .filter(Boolean);

        // month string for prefix match on attendance.date (attendance date format is "YYYY-MM-DD")
        const monthStr = `${year}-${String(monthIndex + 1).padStart(2, '0')}`; // e.g. "2025-11"

        // Build match for PF base
        const pfMatch = {};
        if (search) {
            pfMatch.email = { $regex: search, $options: 'i' };
        }

        // Aggregation: get PF documents + joined employee + shifting assignment + working shift lookup +
        // attendance dates for the month + approved leave docs
        const pipeline = [
            { $match: pfMatch },

            // join employee doc
            {
                $lookup: {
                    from: 'employeeList',
                    localField: 'email',
                    foreignField: 'email',
                    as: 'emp'
                }
            },
            { $unwind: '$emp' },

            // exclude deactivated employees
            { $match: { 'emp.status': { $ne: 'De-activate' } } },

            // join shiftingList (assigned shift info)
            {
                $lookup: {
                    from: 'shiftingList',
                    let: { email: '$email' },
                    pipeline: [
                        { $match: { $expr: { $eq: ['$email', '$$email'] } } },
                        { $limit: 1 }
                    ],
                    as: 'shiftAssign'
                }
            },
            {
                $addFields: {
                    shiftAssign: { $arrayElemAt: ['$shiftAssign', 0] }
                }
            },

            // lookup workingShiftList (possible fallback to holidays/weekends per shiftName+branch)
            {
                $lookup: {
                    from: 'workingShiftList',
                    let: { shiftName: '$shiftAssign.shiftName', branch: '$shiftAssign.branch' },
                    pipeline: [
                        {
                            $match: {
                                $expr: {
                                    $and: [
                                        { $ne: ['$$shiftName', null] },
                                        { $eq: ['$shiftName', '$$shiftName'] },
                                        { $eq: ['$branch', '$$branch'] }
                                    ]
                                }
                            }
                        },
                        { $limit: 1 }
                    ],
                    as: 'workingShift'
                }
            },
            {
                $addFields: {
                    workingShift: { $arrayElemAt: ['$workingShift', 0] }
                }
            },

            // Attendance lookup: get distinct dates (for safety use $addToSet) filtered by month prefix
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
                                        // date field assumed "YYYY-MM-DD" or ISO starting with YYYY-MM
                                        { $regexMatch: { input: '$date', regex: `^${monthStr}` } }
                                    ]
                                }
                            }
                        },
                        {
                            $group: {
                                _id: null,
                                attendanceDates: { $addToSet: '$date' }
                            }
                        },
                        {
                            $project: {
                                _id: 0,
                                attendanceDates: 1,
                                attendanceCount: { $size: { $ifNull: ['$attendanceDates', []] } }
                            }
                        }
                    ],
                    as: 'attendanceMonth'
                }
            },
            {
                $addFields: {
                    attendanceMonth: { $arrayElemAt: ['$attendanceMonth', 0] }
                }
            },

            // Leave lookup: fetch approved leaves for this employee that overlap the month (we will compute counts in JS)
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
                                        { $eq: ['$status', 'Approved'] }
                                    ]
                                }
                            }
                        },
                        {
                            $project: {
                                _id: 1,
                                startDate: 1,
                                endDate: 1,
                                grantedDates: 1
                            }
                        }
                    ],
                    as: 'approvedLeaves'
                }
            },

            // Final projection of required fields
            {
                $project: {
                    email: 1,
                    salary: 1,
                    'emp.fullName': 1,
                    'emp.accountNumber': 1,
                    shiftAssign: 1,
                    workingShift: 1,
                    attendanceMonth: 1,
                    approvedLeaves: 1
                }
            },

            // pagination at aggregation level
            { $skip: skip },
            { $limit: limit }
        ];

        const aggResult = await PFAndSalaryCollections.aggregate(pipeline).toArray();

        // Prepare response rows by computing grantedLeaveCount and weekendCount in JS (fast)
        const rows = [];

        // month start/end moments
        const monthStart = moment.tz(`${year}-${String(monthIndex + 1).padStart(2,'0')}-01`, 'YYYY-MM-DD', 'Asia/Dhaka').startOf('day');
        const monthEnd = monthStart.clone().endOf('month');

        for (const doc of aggResult) {
            const email = String(doc.email || '').toLowerCase();
            const emp = doc.emp || {};
            const salary = Number(doc.salary || 0);

            // if ignored -> full salary
            if (ignoredEmails.includes(email)) {
                const perDaySalary = Number((salary / totalDaysInMonth).toFixed(2));
                rows.push({
                    email,
                    name: emp.fullName || '',
                    accountNumber: emp.accountNumber || '',
                    salary,
                    perDaySalary,
                    present: totalDaysInMonth,
                    absent: 0,
                    total: salary
                });
                continue;
            }

            // attendance count from aggregation (safe)
            const attendanceCount = (doc.attendanceMonth && doc.attendanceMonth.attendanceCount) ? doc.attendanceMonth.attendanceCount : 0;

            // determine weekends: try shiftAssign.weekends first, else workingShift.weekends else []
            let weekends = [];
            if (doc.shiftAssign && Array.isArray(doc.shiftAssign.weekends) && doc.shiftAssign.weekends.length) {
                weekends = doc.shiftAssign.weekends;
            } else if (doc.workingShift && Array.isArray(doc.workingShift.weekends) && doc.workingShift.weekends.length) {
                weekends = doc.workingShift.weekends;
            } else {
                weekends = []; // default: none
            }

            // compute weekend count in month using JS helper
            const weekendCount = countWeekendDaysJS(year, monthIndex, weekends);

            // compute grantedLeaveCount by iterating approvedLeaves
            let grantedLeaveCount = 0;
            for (const leave of (doc.approvedLeaves || [])) {
                // prefer grantedDates array if present
                if (Array.isArray(leave.grantedDates) && leave.grantedDates.length) {
                    for (const ds of leave.grantedDates) {
                        const m = parseGrantedDateToMoment(ds);
                        if (!m) continue;
                        if (m.isBetween(monthStart, monthEnd, 'day', '[]')) grantedLeaveCount++;
                    }
                } else {
                    // fallback: startDate / endDate - try multiple parse formats
                    const sd = parseGrantedDateToMoment(leave.startDate);
                    const ed = parseGrantedDateToMoment(leave.endDate);
                    if (!sd || !ed) continue;
                    const from = moment.max(sd, monthStart);
                    const to = moment.min(ed, monthEnd);
                    if (to.isSameOrAfter(from)) {
                        grantedLeaveCount += to.diff(from, 'days') + 1;
                    }
                }
            }

            // Final present / absent
            let present = attendanceCount + weekendCount + grantedLeaveCount;
            if (present > totalDaysInMonth) present = totalDaysInMonth;
            let absent = totalDaysInMonth - present;
            if (absent < 0) absent = 0;

            const perDaySalary = Number((salary / totalDaysInMonth).toFixed(2));
            const total = Number((perDaySalary * present).toFixed(2));

            rows.push({
                email,
                name: emp.fullName || '',
                accountNumber: emp.accountNumber || '',
                salary,
                perDaySalary,
                present,
                absent,
                total,
                // debug fields (optional) - remove in production
                _debug: {
                    attendanceCount,
                    weekendCount,
                    grantedLeaveCount,
                    weekends
                }
            });
        }

        // Count totalEmployees for pagination (using same pfMatch but counting joined employees non-deactivated is heavier;
        // we will compute with an aggregation count to match earlier behavior)
        const countPipeline = [
            { $match: pfMatch },
            {
                $lookup: { from: 'employeeList', localField: 'email', foreignField: 'email', as: 'emp' }
            },
            { $unwind: '$emp' },
            { $match: { 'emp.status': { $ne: 'De-activate' } } },
            { $count: 'total' }
        ];
        const countAgg = await PFAndSalaryCollections.aggregate(countPipeline).toArray();
        const totalEmployees = countAgg[0]?.total || 0;

        return res.json({
            page,
            limit,
            totalEmployees,
            totalPages: Math.ceil(totalEmployees / limit),
            data: rows
        });
    } catch (err) {
        console.error('Salary sheet aggregate error:', err);
        return res.status(500).json({ message: 'Internal Server Error', error: err.message });
    }
});

module.exports = { salaryRoute };
