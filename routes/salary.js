require('dotenv').config();
const express = require('express');
const { client } = require('../lib/db');

const salaryRoute = express.Router();

const database = client.db('hrManagement');
const PFAndSalaryCollections = database.collection('PFAndSalaryList');
const attendanceCollections = database.collection('attendanceList');
const employeeCollections = database.collection('employeeList');

salaryRoute.get('/get-salary-sheet', async (req, res) => {
    try {
        let { search = '', month = '', page = 1, limit = 20 } = req.query;

        page = Number(page);
        limit = Number(limit);

        const skip = (page - 1) * limit;

        // Search by email OR name
        const searchFilter = search
            ? {
                  $or: [
                      { email: { $regex: search, $options: 'i' } },
                      { name: { $regex: search, $options: 'i' } },
                  ],
              }
            : {};

        const monthFilter = month ? { month } : {};

        // Fetch salary records
        const employees = await PFAndSalaryCollections.find(searchFilter)
            .skip(skip)
            .limit(limit)
            .toArray();

        const totalEmployees = await PFAndSalaryCollections.countDocuments(
            searchFilter
        );

        const results = [];

        for (let emp of employees) {
            const empEmail = emp.email;

            // Fetch employee details (NAME)
            const employeeData = await employeeCollections.findOne({
                email: empEmail,
            });

            const employeeName = employeeData?.fullName || 'Unknown';

            // Attendance for selected month
            const attendance = await attendanceCollections
                .find({ email: empEmail, ...monthFilter })
                .toArray();

            const presentCount = attendance.length;

            // Number of days in selected month
            let totalDaysInMonth = 30;

            if (month) {
                const monthIndex = [
                    'January',
                    'February',
                    'March',
                    'April',
                    'May',
                    'June',
                    'July',
                    'August',
                    'September',
                    'October',
                    'November',
                    'December',
                ].indexOf(month);

                const year = new Date().getFullYear();
                totalDaysInMonth = new Date(year, monthIndex + 1, 0).getDate();
            }

            const absentCount = totalDaysInMonth - presentCount;

            const monthlySalary = emp.salary || 0;
            const perDaySalary = monthlySalary / totalDaysInMonth;
            const totalPayable = perDaySalary * presentCount;

            results.push({
                name: employeeName,
                email: empEmail,
                salary: monthlySalary,
                perDaySalary,
                presentCount,
                absentCount,
                totalPayable,
            });
        }

        res.json({
            page,
            limit,
            totalEmployees,
            totalPages: Math.ceil(totalEmployees / limit),
            data: results,
        });
    } catch (error) {
        console.log(error);
        res.status(500).json({ message: 'Internal Server Error' });
    }
});

module.exports = { salaryRoute };
