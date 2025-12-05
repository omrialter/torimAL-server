// routes/appointments.js
const express = require('express');
const mongoose = require('mongoose');
const Joi = require('joi');
const { UserModel } = require("../models/userModel");
const { AppointmentModel, validateAppointment } = require('../models/appointmentModel');
const { auth, authAdmin } = require('../auth/auth');

const router = express.Router();

const BLOCKING_STATUSES = ['confirmed'];

const minutesToMs = (min) => min * 60 * 1000;
const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

// כמה מילישניות זה 24 שעות
const HOURS_24_MS = 24 * 60 * 60 * 1000;

/**
 * GET /appointments/by-day?date=YYYY-MM-DD&worker=xxxxx
 * מחזיר את התורים של עובד מסוים ביום מסוים (עבור admin)
 */
router.get("/by-day", auth, async (req, res) => {
    try {
        const { business } = req.tokenData;
        const { date, worker } = req.query;

        if (!business || !isValidObjectId(business)) {
            return res.status(400).json({ error: "Invalid or missing business id" });
        }

        if (!date) {
            return res.status(400).json({ error: "date query is required (YYYY-MM-DD)" });
        }

        const day = new Date(date);
        if (Number.isNaN(day.getTime())) {
            return res.status(400).json({ error: "Invalid date format" });
        }

        const dayStart = new Date(day);
        dayStart.setHours(0, 0, 0, 0);

        const dayEnd = new Date(day);
        dayEnd.setHours(23, 59, 59, 999);

        const query = {
            business,
            start: { $gte: dayStart, $lt: dayEnd },
        };

        if (worker && isValidObjectId(worker)) {
            query.worker = worker;
        } else {
            return res.status(400).json({ error: "Missing or invalid worker id" });
        }

        const appts = await AppointmentModel.find(query)
            .sort({ start: 1 })
            .populate("business", "name address phone")
            .populate("worker", "name fullName phone")
            .populate("client", "name phone") // 👈 הכי חשוב
            .lean()
            .exec();

        // אפשר להשאיר לוג דיבאג זמני
        console.log("SERVER by-day sample appt:", appts[0]);

        return res.json(appts);
    } catch (err) {
        console.error(err);
        return res.status(502).json({ error: "Server error" });
    }
});


/**
 * POST /appointments
 * body: { client, worker, service{ name,duration,price }, start, notes? }
 * business מגיע מה-token
 */
router.post('/', auth, async (req, res) => {
    const { business } = req.tokenData;

    // business מה-token, worker & client מה-body
    const payload = { ...req.body, business };

    const { error, value } = validateAppointment(payload);
    if (error) {
        console.error("❌ validateAppointment error:", error.details?.[0]);
        return res.status(400).json({
            error: error.details?.[0]?.message || 'Validation error'
        });
    }

    const { client, worker, service, start, notes } = value;

    if (!isValidObjectId(business) ||
        !isValidObjectId(client) ||
        !isValidObjectId(worker)) {
        return res
            .status(400)
            .json({ error: 'Invalid business/client/worker id' });
    }

    try {
        // לוודא שהלקוח באמת שייך לעסק הזה
        const user = await UserModel.findOne({ _id: client, business }).lean();
        if (!user) {
            return res
                .status(400)
                .json({ error: 'Client does not belong to this business' });
        }

        // לוודא שגם העובד שייך לעסק הזה
        const workerDoc = await UserModel.findOne({ _id: worker, business }).lean();
        if (!workerDoc) {
            return res
                .status(400)
                .json({ error: 'Worker does not belong to this business' });
        }

        const startDate = new Date(start);
        const endDate = new Date(startDate.getTime() + minutesToMs(service.duration));

        // בדיקת חפיפה לתורים של אותו עובד
        const overlapping = await AppointmentModel.findOne({
            business,
            worker,
            status: { $in: BLOCKING_STATUSES },
            $expr: {
                $and: [
                    { $lt: ['$start', endDate] },
                    {
                        $gt: [
                            { $add: ['$start', { $multiply: ['$service.duration', 60000] }] },
                            startDate
                        ]
                    }
                ]
            }
        }).lean();

        if (overlapping) {
            return res.status(409).json({ error: 'SLOT_TAKEN' });
        }

        const doc = await AppointmentModel.create({
            business,
            client,
            worker,
            service,
            start: startDate,
            notes: notes || '',
            status: 'confirmed',
            createdAt: new Date()
        });

        return res.status(201).json(doc);
    } catch (err) {
        console.error("❌ Error in POST /appointments:", err);
        if (err?.code === 11000) {
            return res.status(409).json({ error: 'SLOT_TAKEN' });
        }
        return res.status(500).json({ error: 'Server error' });
    }
});

/**
 * PATCH /appointments/:id/status
 */
const statusSchema = Joi.object({
    status: Joi.string()
        .valid('confirmed', 'canceled', 'completed', 'no_show')
        .required(),
    notes: Joi.string().max(1000).allow('', null)
});

router.patch('/:id/status', authAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { business } = req.tokenData;

        if (!isValidObjectId(id)) {
            return res.status(400).json({ error: 'Invalid appointment id' });
        }

        const appt = await AppointmentModel.findOne({ _id: id, business }).lean();
        if (!appt) {
            return res.status(404).json({ error: 'Appointment not found' });
        }

        const { error, value } = statusSchema.validate(req.body);
        if (error) {
            return res.status(400).json({
                error: error.details?.[0]?.message || 'Validation error'
            });
        }

        const { status, notes } = value;

        // אם מחזירים ל-confirmed, נוודא שאין חפיפה אצל אותו עובד
        if (status === 'confirmed') {
            const startDate = new Date(appt.start);
            const endDate = new Date(
                startDate.getTime() + minutesToMs(appt.service.duration)
            );

            const conflict = await AppointmentModel.findOne({
                _id: { $ne: appt._id },
                business: appt.business,
                worker: appt.worker, // 👈 רק תורים של אותו עובד
                status: { $in: BLOCKING_STATUSES },
                $expr: {
                    $and: [
                        { $lt: ['$start', endDate] },
                        {
                            $gt: [
                                { $add: ['$start', { $multiply: ['$service.duration', 60000] }] },
                                startDate
                            ]
                        }
                    ]
                }
            }).lean();

            if (conflict) {
                return res.status(409).json({ error: 'SLOT_TAKEN' });
            }
        }

        const updated = await AppointmentModel.findOneAndUpdate(
            { _id: id, business },
            {
                status: value.status,
                ...(value.notes ? { notes: value.notes } : {})
            },
            { new: true }
        ).exec();

        if (!updated) {
            return res.status(404).json({ error: 'Appointment not found' });
        }

        return res.json(updated);
    } catch (err) {
        console.error(err);
        return res.status(502).json({ error: 'Server error' });
    }
});


/**
 * PATCH /appointments/:id/cancel
 * ביטול תור ע"י הלקוח (לא אדמין)
 */
router.patch('/:id/cancel', auth, async (req, res) => {
    try {
        const { id } = req.params;
        const { _id: clientId, business } = req.tokenData;

        if (!isValidObjectId(id)) {
            return res.status(400).json({ error: 'Invalid appointment id' });
        }

        if (!isValidObjectId(clientId) || !isValidObjectId(business)) {
            return res.status(400).json({ error: 'Invalid token data' });
        }

        const appt = await AppointmentModel.findOne({
            _id: id,
            client: clientId,
            business
        }).exec();

        if (!appt) {
            return res.status(404).json({ error: 'Appointment not found' });
        }

        if (appt.status !== 'confirmed') {
            return res.status(400).json({ error: 'ONLY_CONFIRMED_CAN_BE_CANCELED' });
        }

        const now = new Date();
        const diffMs = appt.start.getTime() - now.getTime();

        if (diffMs < HOURS_24_MS) {
            return res.status(409).json({
                error: 'CANNOT_CANCEL_WITHIN_24H'
            });
        }

        appt.status = 'canceled';
        await appt.save();

        return res.json(appt);
    } catch (err) {
        console.error('❌ Error in PATCH /appointments/:id/cancel', err);
        return res.status(502).json({ error: 'Server error' });
    }
});

module.exports = router;
