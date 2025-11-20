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

const weekdayNameToNumber = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
};

function countWeekendDays(year, monthIndex, weekendNames = []) {
    if (!weekendNames.length) return 0;

    const weekendNums = weekendNames
        .map((w) => weekdayNameToNumber[w.toLowerCase()])
        .filter((n) => typeof n === 'number');

    let count = 0;
    const totalDays = new Date(year, monthIndex + 1, 0).getDate();

    for (let d = 1; d <= totalDays; d++) {
        const dt = new Date(year, monthIndex, d);
        if (weekendNums.includes(dt.getDay())) count++;
    }
    return count;
}

salaryRoute.get('/get-salary-sheet', async (req, res) => {
    try {
        let { search = '', month = '', page = 1, limit = 20 } = req.query;

        if (!month) return res.json({ data: [], message: 'Select a month' });

        search = search.trim().toLowerCase();
        month = month.trim().toLowerCase();

        const monthIndex = MONTHS.indexOf(month);
        if (monthIndex === -1)
            return res.status(400).json({ message: 'Invalid month' });

        const year = new Date().getFullYear();
        const totalDaysInMonth = new Date(year, monthIndex + 1, 0).getDate();

        page = Number(page) || 1;
        limit = Number(limit) || 20;
        const skip = (page - 1) * limit;

        const ignoredEmails = (process.env.IGNORED_ATTENDANCE_EMAILS || '')
            .split(',')
            .map((e) => e.trim().toLowerCase())
            .filter(Boolean);

        const pfFilter = search
            ? { email: { $regex: search, $options: 'i' } }
            : {};

        const totalEmployees = await PFAndSalaryCollections.countDocuments(
            pfFilter
        );

        const pfList = await PFAndSalaryCollections.find(pfFilter)
            .skip(skip)
            .limit(limit)
            .toArray();

        const results = [];

        const monthStr = `${year}-${String(monthIndex + 1).padStart(2, '0')}`;

        const monthStart = moment.tz(
            `${monthStr}-01`,
            'YYYY-MM-DD',
            'Asia/Dhaka'
        );
        const monthEnd = monthStart.clone().endOf('month');

        for (const pf of pfList) {
            const email = pf.email.toLowerCase();
            const salary = Number(pf.salary || 0);

            const emp = await employeeCollections.findOne({ email });
            if (!emp || emp.status === 'De-activate') continue;

            if (search) {
                const matchName = (emp.fullName || '')
                    .toLowerCase()
                    .includes(search);
                const matchEmail = email.includes(search);
                if (!matchName && !matchEmail) continue;
            }

            // IGNORED EMPLOYEE — FULL SALARY
            if (ignoredEmails.includes(email)) {
                const perDaySalary = Number(
                    (salary / totalDaysInMonth).toFixed(2)
                );
                results.push({
                    email,
                    name: emp.fullName,
                    accountNumber: emp.accountNumber || '',
                    salary,
                    perDaySalary,
                    present: totalDaysInMonth,
                    absent: 0,
                    total: salary,
                });
                continue;
            }

            // ------------------------------
            // 1️⃣ ATTENDANCE COUNT (Fix Applied)
            // ------------------------------
            const attendanceCount = await attendanceCollections.countDocuments({
                email: email,
                date: { $regex: `^${monthStr}` }, // FIXED
            });

            // ------------------------------
            // 2️⃣ SHIFT WEEKENDS
            // ------------------------------
            const shiftAssign =
                (await shiftingCollections.findOne({ email })) || {};
            let weekends = shiftAssign.weekends || [];

            if ((!weekends || !weekends.length) && shiftAssign.shiftName) {
                const ws = await workingShiftCollections.findOne({
                    shiftName: shiftAssign.shiftName,
                    branch: shiftAssign.branch,
                });
                weekends = ws?.weekends || [];
            }

            const weekendCount = countWeekendDays(year, monthIndex, weekends);

            // ------------------------------
            // 3️⃣ LEAVE GRANTED DAYS
            // ------------------------------
            const leaves = await leaveCollections
                .find({
                    email,
                    status: 'Approved',
                })
                .toArray();

            let grantedLeaveCount = 0;

            for (const leave of leaves) {
                if (
                    Array.isArray(leave.grantedDates) &&
                    leave.grantedDates.length
                ) {
                    for (const d of leave.grantedDates) {
                        const m = moment.tz(
                            d,
                            ['DD-MMM-YYYY', 'YYYY-MM-DD'],
                            'Asia/Dhaka'
                        );
                        if (m.isBetween(monthStart, monthEnd, 'day', '[]')) {
                            grantedLeaveCount++;
                        }
                    }
                } else {
                    const sd = moment.tz(
                        leave.startDate,
                        'DD-MMM-YYYY',
                        'Asia/Dhaka'
                    );
                    const ed = moment.tz(
                        leave.endDate,
                        'DD-MMM-YYYY',
                        'Asia/Dhaka'
                    );
                    if (!sd.isValid() || !ed.isValid()) continue;

                    const from = moment.max(sd, monthStart);
                    const to = moment.min(ed, monthEnd);

                    if (to.isSameOrAfter(from)) {
                        grantedLeaveCount += to.diff(from, 'days') + 1;
                    }
                }
            }

            // ------------------------------
            // FINAL PRESENT / ABSENT
            // ------------------------------
            let present = attendanceCount + weekendCount + grantedLeaveCount;
            if (present > totalDaysInMonth) present = totalDaysInMonth;

            let absent = totalDaysInMonth - present;
            if (absent < 0) absent = 0;

            const perDaySalary = Number((salary / totalDaysInMonth).toFixed(2));
            const total = Number((perDaySalary * present).toFixed(2));

            results.push({
                email,
                name: emp.fullName,
                accountNumber: emp.accountNumber || '',
                salary,
                perDaySalary,
                present,
                absent,
                total,
            });
        }

        res.json({
            page,
            limit,
            totalEmployees,
            totalPages: Math.ceil(totalEmployees / limit),
            data: results,
        });
    } catch (err) {
        console.error('Salary sheet error:', err);
        return res
            .status(500)
            .json({ message: 'Internal Server Error', error: err.message });
    }
});

module.exports = { salaryRoute };
