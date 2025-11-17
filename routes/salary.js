require('dotenv').config();
const express = require('express');
const { client } = require('../lib/db');

const salaryRoute = express.Router();

const database = client.db('hrManagement');
const PFAndSalaryCollections = database.collection('PFAndSalaryList');
const attendanceCollections = database.collection('attendanceList');
const employeeCollections = database.collection('employeeList');

const MONTHS = [
    'january','february','march','april','may','june',
    'july','august','september','october','november','december'
];

function countSundays(year, monthIndex) {
    const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
    let sundays = 0;
    for (let day = 1; day <= daysInMonth; day++) {
        if (new Date(year, monthIndex, day).getDay() === 0) sundays++;
    }
    return sundays;
}

salaryRoute.get('/get-salary-sheet', async (req, res) => {
    try {
        let { search = '', month = '', page = 1, limit = 20 } = req.query;

        // Month is required
        if (!month) {
            return res.json({
                page: 1,
                limit: Number(limit),
                totalEmployees: 0,
                totalPages: 0,
                data: [],
                message: 'Please select a month to view salary sheet.',
            });
        }

        // Normalize month name
        const monthNormalized = String(month).trim().toLowerCase();
        const monthIndex = MONTHS.indexOf(monthNormalized);

        if (monthIndex === -1) {
            return res.status(400).json({
                message: 'Invalid month. Expected full month name like "October".',
                received: month,
            });
        }

        page = Number(page);
        limit = Number(limit);
        const skip = (page - 1) * limit;

        const year = new Date().getFullYear();
        const totalDaysInMonth = new Date(year, monthIndex + 1, 0).getDate();
        const sundays = countSundays(year, monthIndex);

        // Present days will be: real-attendance + Sundays
        const attendanceMonthLower = monthNormalized;

        const pfMatch = {};
        if (search) {
            pfMatch.email = { $regex: search, $options: 'i' };
        }

        // BUILD PIPELINE
        const pipeline = [
            { $match: pfMatch },

            // Join employee
            {
                $lookup: {
                    from: 'employeeList',
                    localField: 'email',
                    foreignField: 'email',
                    as: 'emp',
                },
            },
            { $unwind: '$emp' },

            // Exclude deactivated
            { $match: { 'emp.status': { $ne: 'De-activate' } } },
        ];

        // Add name search also
        if (search) {
            pipeline.push({
                $match: {
                    $or: [
                        { email: { $regex: search, $options: 'i' } },
                        { 'emp.fullName': { $regex: search, $options: 'i' } },
                    ],
                },
            });
        }

        // Lookup attendance count for selected month
        pipeline.push(
            {
                $lookup: {
                    from: 'attendanceList',
                    let: { empEmail: '$email' },
                    pipeline: [
                        {
                            $match: {
                                $expr: {
                                    $and: [
                                        { $eq: ['$email', '$$empEmail'] },
                                        {
                                            $eq: [
                                                { $toLower: '$month' },
                                                attendanceMonthLower,
                                            ],
                                        },
                                    ],
                                },
                            },
                        },
                        { $count: 'presentCount' },
                    ],
                    as: 'attendance',
                },
            },

            // Add salary calculations
            {
                $addFields: {
                    rawPresent: {
                        $ifNull: [{ $arrayElemAt: ['$attendance.presentCount', 0] }, 0],
                    },
                },
            },
            {
                $addFields: {
                    // present = real present days + Sundays
                    presentCount: {
                        $add: [
                            '$rawPresent',
                            sundays
                        ]
                    },

                    // absent = totalDays - present
                    absentCount: {
                        $subtract: [totalDaysInMonth, { $add: ['$rawPresent', sundays] }]
                    },

                    perDaySalary: {
                        $round: [
                            { $divide: ['$salary', totalDaysInMonth] },
                            2
                        ]
                    },

                    totalPayable: {
                        $round: [
                            {
                                $multiply: [
                                    { $divide: ['$salary', totalDaysInMonth] },
                                    { $add: ['$rawPresent', sundays] }
                                ]
                            },
                            2
                        ]
                    },

                    name: '$emp.fullName'
                }
            },

            // Cleanup
            {
                $project: {
                    emp: 0,
                    attendance: 0,
                    rawPresent: 0
                }
            },

            { $skip: skip },
            { $limit: limit }
        );

        const data = await PFAndSalaryCollections.aggregate(pipeline).toArray();

        // COUNT PIPELINE
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
        ];

        if (search) {
            countPipeline.push({
                $match: {
                    $or: [
                        { email: { $regex: search, $options: 'i' } },
                        { 'emp.fullName': { $regex: search, $options: 'i' } },
                    ],
                },
            });
        }

        countPipeline.push({ $count: 'total' });

        const countResult = await PFAndSalaryCollections.aggregate(countPipeline).toArray();
        const totalEmployees = countResult[0]?.total || 0;

        return res.json({
            page,
            limit,
            totalEmployees,
            totalPages: Math.ceil(totalEmployees / limit),
            data,
        });

    } catch (error) {
        console.error('Salary sheet error:', error);
        return res.status(500).json({ message: 'Internal Server Error' });
    }
});

module.exports = { salaryRoute };
