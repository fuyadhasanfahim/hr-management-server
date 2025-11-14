const { Router } = require('express');
const moment = require('moment-timezone');
const { client } = require('../lib/db');

const router = Router();
const database = client.db('hrManagement');
const expenseCollections = database.collection('expenseList');

router.get('/expense-summary', async (req, res) => {
    try {
        const now = moment().tz('Asia/Dhaka');
        const todayStart = now.clone().startOf('day').toDate();
        const todayEnd = now.clone().endOf('day').toDate();
        const monthStart = now.clone().startOf('month').toDate();
        const monthEnd = now.clone().endOf('month').toDate();
        const yearStart = now.clone().startOf('year').toDate();
        const yearEnd = now.clone().endOf('year').toDate();

        const convertDateStage = {
            $addFields: {
                parsedDate: {
                    $cond: [
                        { $eq: [{ $type: '$expenseDate' }, 'string'] },
                        { $toDate: '$expenseDate' },
                        '$expenseDate',
                    ],
                },
            },
        };

        // ✅ Daily Expense
        const dailyExpense =
            (
                await expenseCollections
                    .aggregate([
                        convertDateStage,
                        {
                            $match: {
                                parsedDate: {
                                    $gte: todayStart,
                                    $lte: todayEnd,
                                },
                            },
                        },
                        {
                            $group: {
                                _id: null,
                                total: { $sum: '$expenseAmount' },
                            },
                        },
                    ])
                    .toArray()
            )[0]?.total || 0;

        // ✅ Monthly Expense
        const monthlyExpense =
            (
                await expenseCollections
                    .aggregate([
                        convertDateStage,
                        {
                            $match: {
                                parsedDate: {
                                    $gte: monthStart,
                                    $lte: monthEnd,
                                },
                            },
                        },
                        {
                            $group: {
                                _id: null,
                                total: { $sum: '$expenseAmount' },
                            },
                        },
                    ])
                    .toArray()
            )[0]?.total || 0;

        // ✅ Yearly Expense
        const yearlyExpense =
            (
                await expenseCollections
                    .aggregate([
                        convertDateStage,
                        {
                            $match: {
                                parsedDate: { $gte: yearStart, $lte: yearEnd },
                            },
                        },
                        {
                            $group: {
                                _id: null,
                                total: { $sum: '$expenseAmount' },
                            },
                        },
                    ])
                    .toArray()
            )[0]?.total || 0;

        // ✅ Monthly Chart
        const monthlyChartAgg = await expenseCollections
            .aggregate([
                convertDateStage,
                { $match: { parsedDate: { $gte: yearStart, $lte: yearEnd } } },
                {
                    $group: {
                        _id: { month: { $month: '$parsedDate' } },
                        total: { $sum: '$expenseAmount' },
                    },
                },
                { $sort: { '_id.month': 1 } },
            ])
            .toArray();

        const monthlyChart = monthlyChartAgg.map((m) => ({
            name: moment()
                .month(m._id.month - 1)
                .format('MMM'),
            expenses: m.total,
        }));

        // ✅ Most-used (frequent) categories — ALL TIME
        const topCategoriesFreqAgg = await expenseCollections
            .aggregate([
                convertDateStage,
                {
                    $group: {
                        _id: '$expenseCategory',
                        totalAmount: { $sum: '$expenseAmount' },
                        count: { $sum: 1 },
                    },
                },
                { $sort: { count: -1 } },
                { $limit: 4 },
            ])
            .toArray();

        const topCategories = topCategoriesFreqAgg.map((c) => ({
            category: c._id || 'Uncategorized',
            amount: c.totalAmount,
            usedCount: c.count,
        }));

        // ✅ Top 4 by expense this month (optional)
        const topByExpenseAgg = await expenseCollections
            .aggregate([
                convertDateStage,
                {
                    $match: {
                        parsedDate: { $gte: monthStart, $lte: monthEnd },
                    },
                },
                {
                    $group: {
                        _id: '$expenseCategory',
                        total: { $sum: '$expenseAmount' },
                    },
                },
                { $sort: { total: -1 } },
                { $limit: 4 },
            ])
            .toArray();

        const topCategoriesByExpense = topByExpenseAgg.map((c) => ({
            category: c._id || 'Uncategorized',
            amount: c.total,
        }));

        res.status(200).json({
            success: true,
            dailyExpense,
            monthlyExpense,
            yearlyExpense,
            monthlyChart,
            topCategories, // ✅ 4 most-used overall
            topCategoriesByExpense, // ✅ optional monthly top
        });
    } catch (error) {
        console.error('❌ Expense summary error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to calculate expense summary',
            error: error.message,
        });
    }
});

const expenseRoute = router;
module.exports = { expenseRoute };
