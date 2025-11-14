require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { client } = require('../lib/db');

const employeeRoute = express.Router();
const database = client.db('hrManagement');
const employeeCollections = database.collection('employeeList');
const userCollections = database.collection('userList');

const mailTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
    },
});

employeeRoute.post('/add-employee', async (req, res) => {
    try {
        const { email, eid, salary, role, branch } = req.body;

        if (!email || !eid || !salary || !role) {
            return res.status(400).json({
                success: false,
                message: 'email, eid, salary and role are required fields.',
            });
        }

        const normalizedEmail = String(email).trim().toLowerCase();

        const existsInEmployees = await employeeCollections.findOne({
            email: normalizedEmail,
        });
        if (existsInEmployees) {
            return res.status(409).json({
                success: false,
                message: 'Employee already exists with this email.',
            });
        }

        const existsByEid = await employeeCollections.findOne({ eid });
        if (existsByEid) {
            return res.status(409).json({
                success: false,
                message: `Employee with EID ${eid} already exists.`,
            });
        }

        const existsInUsers = await userCollections.findOne({
            email: normalizedEmail,
        });

        const activationToken = jwt.sign(
            { email: normalizedEmail },
            process.env.TOKEN_SECRET,
            { expiresIn: '7d' }
        );

        const activationLink = `${process.env.FRONTEND_URL}/create-account?token=${activationToken}`;

        const employeeDoc = {
            email: normalizedEmail,
            eid,
            salary,
            role,
            branch,
            status: 'pending',
            createdAt: new Date(),
            updatedAt: new Date(),
            activationToken,
        };

        const username =
            typeof normalizedEmail === 'string' && normalizedEmail.includes('@')
                ? normalizedEmail
                      .split('@')[0]
                      .replace(/[^a-zA-Z0-9]/g, '')
                      .toLowerCase()
                : '';

        let userInsertedId = null;
        if (!existsInUsers) {
            const userDoc = {
                email: normalizedEmail,
                role,
                username,
                branch,
                createdAt: new Date(),
                updatedAt: new Date(),
                isActive: false,
            };
            const userRes = await userCollections.insertOne(userDoc);
            userInsertedId = userRes.insertedId;
        }

        const empRes = await employeeCollections.insertOne(employeeDoc);

        await mailTransporter.sendMail({
            from: process.env.SMTP_USER,
            to: normalizedEmail,
            subject: 'Complete Your Web Briks Account Setup',
            html: `
                <div style="font-family:sans-serif;">
                    <h2>Welcome to Web Briks!</h2>
                    <p>You’ve been added as a new ${role}. Click below to complete your account setup:</p>
                    <a href="${activationLink}" target="_blank"
                        style="display:inline-block;padding:10px 18px;background:#009999;color:#fff;text-decoration:none;border-radius:6px;margin-top:12px;">
                        Complete My Account
                    </a>
                    <p style="margin-top:20px;color:#7F00FF;">This link will expire in 7 days.</p>
                </div>
            `,
        });

        return res.status(201).json({
            success: true,
            message: 'Employee added and activation email sent.',
            employeeId: empRes.insertedId,
            userId: userInsertedId,
        });
    } catch (error) {
        console.error('Error adding employee:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to add employee',
            error: error.message,
        });
    }
});

employeeRoute.post('/activate-user', async (req, res) => {
    try {
        const { email, firebaseUID } = req.body;
        const user = await userCollections.findOneAndUpdate(
            { email },
            {
                $set: {
                    emailVerified: true,
                    isActive: true,
                },
            },
            { new: true }
        );

        await employeeCollections.findOneAndUpdate(
            { email },
            {
                $set: { firebaseUID, status: 'Active' },
            },
            { new: true }
        );
        if (!user)
            return res
                .status(404)
                .json({ success: false, message: 'User not found' });

        return res.json({ success: true, message: 'User activated' });
    } catch (err) {
        console.error(err);
        return res
            .status(500)
            .json({ success: false, message: 'Server error' });
    }
});

employeeRoute.post('/complete-profile', async (req, res) => {
    try {
        const { email, ...profile } = req.body;

        const employee = await employeeCollections.findOne({ email });
        if (!employee) {
            return res
                .status(404)
                .json({ success: false, message: 'Employee not found.' });
        }

        await employeeCollections.updateOne(
            { email },
            {
                $set: {
                    ...profile,
                },
            },
            {
                new: true,
            }
        );

        res.json({ success: true, message: 'Profile completed successfully.' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = { employeeRoute };
