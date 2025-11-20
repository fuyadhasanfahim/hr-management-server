const { Router } = require('express');
const { client } = require('../lib/db');
const { ObjectId } = require('mongodb');

const router = Router();
const database = client.db('hrManagement');

const shiftCollection = database.collection('workingShiftList');
const userCollections = database.collection('userList');
const shiftingCollections = database.collection('shiftingList'); // moved up

// =======================================================
// UPDATE SHIFT (NOW INCLUDES WEEKENDS)
// =======================================================
router.put('/update-shift', async (req, res) => {
    try {
        const data = req.body;

        const {
            _id,
            shiftName,
            branch,
            startTime,
            endTime,
            userEmail,
            lateAfterMinutes,
            absentAfterMinutes,
            allowOT,
            weekends, // NEW FIELD
        } = data;

        if (!_id) {
            return res.status(400).json({
                success: false,
                message: 'Shift ID is required.',
            });
        }

        if (!shiftName || !branch || !startTime || !endTime) {
            return res.status(400).json({
                success: false,
                message:
                    'Shift name, branch, startTime, and endTime are required.',
            });
        }

        // AUTH
        const userDoc = await userCollections.findOne(
            { email: userEmail },
            { projection: { role: 1 } }
        );

        const allowedRoles = ['admin', 'hr-admin', 'developer'];
        if (!userDoc || !allowedRoles.includes(userDoc.role?.toLowerCase())) {
            return res.status(403).json({
                success: false,
                message:
                    'Only Admin, HR Admin, or Developer can update a shift.',
            });
        }

        // BUILD UPDATE BODY
        const updateBody = {
            shiftName,
            branch,
            startTime,
            endTime,
            lateAfterMinutes: Number(lateAfterMinutes) || 5,
            absentAfterMinutes: Number(absentAfterMinutes) || 60,
            allowOT,
            weekends: weekends || [],
        };

        // UPDATE SHIFT DOCUMENT
        const result = await shiftCollection.findOneAndUpdate(
            { _id: new ObjectId(String(_id)) },
            { $set: updateBody },
            { returnDocument: 'after' }
        );

        if (!result) {
            return res.status(404).json({
                success: false,
                message: 'Shift not found.',
            });
        }

        // ======================================================
        // AUTO UPDATE ALL ASSIGNED EMPLOYEES WITH NEW WEEKENDS
        // ======================================================
        const assignUpdate = await shiftingCollections.updateMany(
            { shiftName, branch },
            {
                $set: {
                    startTime,
                    endTime,
                    lateAfterMinutes: Number(lateAfterMinutes) || 5,
                    absentAfterMinutes: Number(absentAfterMinutes) || 60,
                    allowOT,
                    weekends: weekends || [], // APPLY TO ALL ASSIGNED EMPLOYEES
                },
            }
        );

        return res.status(200).json({
            success: true,
            message: `Shift "${shiftName}" updated successfully.`,
            updatedShift: result.value,
            updatedAssignedEmployees: assignUpdate.modifiedCount,
        });
    } catch (err) {
        console.error('Update Shift Error:', err);
        return res.status(500).json({
            success: false,
            message: 'Internal server error.',
        });
    }
});

// =======================================================
// DELETE SHIFT
// =======================================================
router.delete('/delete-shift/:id', async (req, res) => {
    try {
        const shiftId = req.params.id;
        const { userEmail } = req.query;

        if (!shiftId) {
            return res.status(400).json({
                success: false,
                message: 'Shift ID is required.',
            });
        }

        const userDoc = await userCollections.findOne(
            { email: userEmail },
            { projection: { role: 1 } }
        );

        const allowedRoles = ['admin', 'hr-admin', 'developer'];
        if (!userDoc || !allowedRoles.includes(userDoc.role?.toLowerCase())) {
            return res.status(403).json({
                success: false,
                message:
                    'Only Admin, HR Admin, or Developer can delete a working shift.',
            });
        }

        const result = await shiftCollection.deleteOne({
            _id: new ObjectId(shiftId),
        });

        if (result.deletedCount === 0) {
            return res.status(404).json({
                success: false,
                message: 'Shift not found.',
            });
        }

        return res.status(200).json({
            success: true,
            message: 'Shift deleted successfully.',
        });
    } catch (err) {
        console.error('Delete Shift Error:', err);
        return res.status(500).json({
            success: false,
            message: 'Internal server error.',
        });
    }
});

// =======================================================
// CREATE SHIFT (NOW SAVES WEEKENDS)
// =======================================================
router.post('/new-shift', async (req, res) => {
    try {
        const {
            shiftName,
            branch,
            startTime,
            endTime,
            lateAfterMinutes,
            absentAfterMinutes,
            allowOT,
            weekends, // NEW FIELD
            userEmail,
        } = req.body;

        const userDoc = await userCollections.findOne(
            { email: userEmail },
            { projection: { role: 1 } }
        );

        const allowedRoles = ['admin', 'hr-admin', 'developer'];
        if (!userDoc || !allowedRoles.includes(userDoc.role.toLowerCase())) {
            return res.status(403).json({
                success: false,
                message:
                    'Only Admin, HR Admin, or Developer can create a working shift.',
            });
        }

        if (!shiftName || !branch || !startTime || !endTime) {
            return res.status(400).json({
                success: false,
                message:
                    'Shift name, branch, startTime, and endTime are required.',
            });
        }

        const existing = await shiftCollection.findOne({ shiftName, branch });
        if (existing) {
            return res.status(409).json({
                success: false,
                message: `Shift "${shiftName}" already exists for branch "${branch}".`,
            });
        }

        const shiftDoc = {
            shiftName,
            branch,
            startTime,
            endTime,
            lateAfterMinutes: lateAfterMinutes ?? 5,
            absentAfterMinutes: absentAfterMinutes ?? 60,
            allowOT: allowOT ?? true,
            weekends: weekends || [], // NEW WEEKEND FIELD
            createdBy: userEmail,
            createdAt: new Date(),
        };

        const result = await shiftCollection.insertOne(shiftDoc);

        return res.status(201).json({
            success: true,
            message: `Shift "${shiftName}" created successfully for branch "${branch}".`,
            insertedId: result.insertedId,
        });
    } catch (error) {
        console.error('Error creating shift:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to create shift',
            error: error.message,
        });
    }
});

// =======================================================
// GET SHIFTS
// =======================================================
router.get('/get-shifts', async (req, res) => {
    try {
        const userEmail = req.query.userEmail;

        const userDoc = await userCollections.findOne(
            { email: userEmail },
            { projection: { role: 1, branch: 1 } }
        );

        if (!userDoc) {
            return res.status(401).json({
                success: false,
                message: 'Unauthorized: user not found.',
            });
        }

        let query = {};

        const allowedAdminRoles = ['admin', 'hr-admin', 'developer'];
        const role = userDoc.role?.toLowerCase();

        if (role === 'teamleader' || role === 'team-leader') {
            query.branch = userDoc.branch;
        } else if (allowedAdminRoles.includes(role)) {
            if (req.query.branch) {
                query.branch = req.query.branch;
            }
        } else {
            return res.status(403).json({
                success: false,
                message: 'You are not authorized to view shift data.',
            });
        }

        if (req.query.search) {
            query.shiftName = { $regex: req.query.search, $options: 'i' };
        }

        const shifts = await shiftCollection
            .find(query)
            .sort({ createdAt: -1 })
            .toArray();

        return res.status(200).json({
            success: true,
            total: shifts.length,
            shifts,
        });
    } catch (error) {
        console.error('Error fetching shifts:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch shifts',
            error: error.message,
        });
    }
});

module.exports = { shiftRoute: router };
