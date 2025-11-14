const express = require('express');
const { ObjectId } = require('mongodb');
const { client } = require('../lib/db.js');

const loanRouter = express.Router();

// New user
loanRouter.post('/new-person', async (req, res) => {
    try {
        const { name, phone, address, description } = req.body;

        if (!name || !phone) {
            return res.status(400).json({
                success: false,
                message:
                    'Missing required fields: name and phone are required.',
            });
        }

        const loanUserCollection = client
            .db('hrManagement')
            .collection('loanUser');

        const existingUser = await loanUserCollection.findOne({
            $or: [{ phone }, { name }],
        });

        if (existingUser) {
            return res.status(400).json({
                success: false,
                message: 'A user with the same name or phone already exists.',
            });
        }

        const result = await loanUserCollection.insertOne({
            name: name.trim(),
            phone: phone.trim(),
            address: address?.trim() || '',
            description: description?.trim() || '',
            createdAt: new Date(),
            updatedAt: new Date(),
        });

        if (!result.insertedId) {
            throw new Error('Insert failed.');
        }

        return res.status(201).json({
            success: true,
            message: '✅ Person added successfully.',
        });
    } catch (error) {
        console.error('Error adding person:', error);
        return res.status(500).json({
            success: false,
            message: error.message || 'Failed to add person.',
        });
    }
});

// get user info
loanRouter.get('/get-person', async (req, res) => {
    try {
        const { query } = req.query;

        if (!query || !query.trim()) {
            return res.status(400).json({
                success: false,
                message: 'Search query is required (name or phone).',
            });
        }

        const loanUserCollection = client
            .db('hrManagement')
            .collection('loanUser');

        const person = await loanUserCollection
            .find({
                $or: [
                    { phone: query },
                    { name: { $regex: query, $options: 'i' } },
                ],
            })
            .sort({ createdAt: -1 })
            .limit(10)
            .toArray();

        if (!person || person.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'No matching person found.',
            });
        }

        return res.status(200).json({
            success: true,
            data: person,
        });
    } catch (error) {
        console.error('Error fetching person:', error);
        return res.status(500).json({
            success: false,
            message: error.message || 'Failed to fetch person info.',
        });
    }
});

loanRouter.post('/new-loan', async (req, res) => {
    try {
        const { name, phone, address, amount, type, date } = req.body;

        if (!name || !phone || !amount || !type || !date) {
            return res.status(400).json({ message: 'Missing required fields' });
        }

        const loanCollection = client.db('hrManagement').collection('loanList');
        const balanceCollection = client
            .db('hrManagement')
            .collection('loanBalance');

        const transactionDate = new Date(date);

        const transaction = {
            name,
            phone,
            address: address || '',
            amount: parseFloat(amount),
            type,
            date: transactionDate,
            createdAt: new Date(),
            updatedAt: new Date(),
        };

        await loanCollection.insertOne(transaction);

        const incrementValue =
            type === 'borrow' ? parseFloat(amount) : -parseFloat(amount);

        const balanceDoc = await balanceCollection.findOne();
        if (balanceDoc) {
            await balanceCollection.updateOne(
                {},
                {
                    $inc: { total: incrementValue },
                    $set: { updatedAt: new Date() },
                }
            );
        } else {
            await balanceCollection.insertOne({
                total: incrementValue,
                createdAt: new Date(),
                updatedAt: new Date(),
            });
        }

        res.status(201).json({
            success: true,
            message: 'Loan record added successfully.',
            data: transaction,
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to add loan record',
        });
    }
});

loanRouter.get('/get-loans', async (req, res) => {
    try {
        const { search = '', page = 1, limit = 10, date } = req.query;

        const loanCollection = client.db('hrManagement').collection('loanList');
        const currentPage = Math.max(parseInt(page) || 1, 1);
        const perPage = Math.max(parseInt(limit) || 10, 1);
        const skip = (currentPage - 1) * perPage;

        const searchFilter = {};

        if (search) {
            searchFilter.$or = [
                { name: { $regex: search, $options: 'i' } },
                { phone: { $regex: search, $options: 'i' } },
                { type: { $regex: search, $options: 'i' } },
            ];
        }

        if (date) {
            const start = new Date(date);
            const end = new Date(date);
            end.setHours(23, 59, 59, 999);
            searchFilter.date = { $gte: start, $lte: end };
        }

        const [items, total, totalsAgg, overallTotalsAgg] = await Promise.all([
            loanCollection
                .find(searchFilter)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(perPage)
                .toArray(),

            loanCollection.countDocuments(searchFilter),

            loanCollection
                .aggregate([
                    { $match: searchFilter },
                    {
                        $group: {
                            _id: null,
                            totalBorrowed: {
                                $sum: {
                                    $cond: [
                                        { $eq: ['$type', 'borrow'] },
                                        '$amount',
                                        0,
                                    ],
                                },
                            },
                            totalReturned: {
                                $sum: {
                                    $cond: [
                                        { $eq: ['$type', 'return'] },
                                        '$amount',
                                        0,
                                    ],
                                },
                            },
                        },
                    },
                    {
                        $project: {
                            _id: 0,
                            totalBorrowed: 1,
                            totalReturned: 1,
                            netBalance: {
                                $subtract: ['$totalBorrowed', '$totalReturned'],
                            },
                        },
                    },
                ])
                .toArray(),

            loanCollection
                .aggregate([
                    {
                        $group: {
                            _id: null,
                            overallBorrowed: {
                                $sum: {
                                    $cond: [
                                        { $eq: ['$type', 'borrow'] },
                                        '$amount',
                                        0,
                                    ],
                                },
                            },
                            overallReturned: {
                                $sum: {
                                    $cond: [
                                        { $eq: ['$type', 'return'] },
                                        '$amount',
                                        0,
                                    ],
                                },
                            },
                        },
                    },
                    {
                        $project: {
                            _id: 0,
                            overallBorrowed: 1,
                            overallReturned: 1,
                            overallNetBalance: {
                                $subtract: [
                                    '$overallBorrowed',
                                    '$overallReturned',
                                ],
                            },
                        },
                    },
                ])
                .toArray(),
        ]);

        const filteredStats = totalsAgg[0] || {
            totalBorrowed: 0,
            totalReturned: 0,
            netBalance: 0,
        };

        const overallStats = overallTotalsAgg[0] || {
            overallBorrowed: 0,
            overallReturned: 0,
            overallNetBalance: 0,
        };

        res.status(200).json({
            success: true,
            message: 'Loans fetched successfully',
            data: {
                loans: items,
                filteredStats,
                overallStats,
                pagination: {
                    total,
                    page: currentPage,
                    limit: perPage,
                    totalPages: Math.ceil(total / perPage),
                },
            },
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to fetch loan records',
        });
    }
});

loanRouter.put('/update-loan/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, phone, address, amount, type, date } = req.body;

        if (!ObjectId.isValid(id)) {
            return res.status(400).json({ message: 'Invalid loan ID' });
        }

        const loanCollection = client.db('hrManagement').collection('loanList');
        const balanceCollection = client
            .db('hrManagement')
            .collection('loanBalance');

        const oldTx = await loanCollection.findOne({ _id: new ObjectId(id) });
        if (!oldTx) {
            return res.status(404).json({ message: 'Transaction not found' });
        }

        const newAmount = parseFloat(amount);
        const oldAmount = oldTx.amount;
        let balanceChange = 0;

        if (oldTx.type === type) {
            if (type === 'borrow') {
                balanceChange = newAmount - oldAmount;
            } else {
                balanceChange = oldAmount - newAmount;
            }
        } else {
            if (oldTx.type === 'borrow' && type === 'return') {
                balanceChange = -(oldAmount + newAmount);
            } else if (oldTx.type === 'return' && type === 'borrow') {
                balanceChange = oldAmount + newAmount;
            }
        }

        const safeDate = date ? new Date(date) : new Date();

        await loanCollection.updateOne(
            { _id: new ObjectId(id) },
            {
                $set: {
                    name,
                    phone,
                    address: address || '',
                    amount: newAmount,
                    type,
                    date: safeDate,
                },
            }
        );

        await balanceCollection.updateOne(
            {},
            { $inc: { total: balanceChange } }
        );

        res.status(200).json({
            success: true,
            message: 'Loan updated successfully',
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to update loan record',
        });
    }
});

loanRouter.delete('/delete-loan/:id', async (req, res) => {
    try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
            return res.status(400).json({ message: 'Invalid loan ID' });
        }

        const loanCollection = client.db('hrManagement').collection('loanList');
        const balanceCollection = client
            .db('hrManagement')
            .collection('loanBalance');

        const transaction = await loanCollection.findOne({
            _id: new ObjectId(id),
        });
        if (!transaction) {
            return res.status(404).json({ message: 'Transaction not found' });
        }

        const reverseAmount =
            transaction.type === 'borrow'
                ? -transaction.amount
                : transaction.amount;

        await loanCollection.deleteOne({ _id: new ObjectId(id) });

        await balanceCollection.updateOne(
            {},
            { $inc: { total: reverseAmount } }
        );

        res.status(200).json({
            success: true,
            message: 'Loan deleted successfully',
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to delete loan record',
        });
    }
});

loanRouter.get('/get-loan-balance', async (req, res) => {
    try {
        const balanceCollection = client
            .db('hrManagement')
            .collection('loanBalance');

        const balanceDoc = await balanceCollection.findOne(
            {},
            { sort: { updatedAt: -1 } }
        );

        if (!balanceDoc) {
            return res.status(404).json({
                success: false,
                message: 'No loan balance record found',
                data: { total: 0 },
            });
        }

        res.status(200).json({
            success: true,
            data: {
                total: balanceDoc.total || 0,
                createdAt: balanceDoc.createdAt || null,
                updatedAt: balanceDoc.updatedAt || null,
                _id: balanceDoc._id,
            },
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to fetch loan balance',
        });
    }
});

module.exports = { loanRouter };
