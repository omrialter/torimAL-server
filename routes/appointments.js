// routes/appointments.js
const express = require("express");
const mongoose = require("mongoose");
const Joi = require("joi");
const { UserModel } = require("../models/userModel");
const { AppointmentModel, validateAppointment } = require("../models/appointmentModel");
const { auth, authAdmin } = require("../auth/auth");

const router = express.Router();

const BLOCKING_STATUSES = ["confirmed"];
const minutesToMs = (min) => min * 60 * 1000;
const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

/**
 * עוזר - טווח יום UTC
 */
function utcDayRange(dateStr) {
    const start = new Date(`${dateStr}T00:00:00.000Z`);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    return { start, end };
}

/**
 * ------------------------------------------------------------------
 * GET /appointments/by-day (אדמין)
 * ------------------------------------------------------------------
 * מביא את כל התורים של עובד מסוים ביום מסוים
 */
router.get("/by-day", auth, async (req, res) => {
    try {
        const { date, worker } = req.query;
        const { business } = req.tokenData;

        if (!business || !isValidObjectId(business)) {
            return res.status(400).json({ error: "Invalid or missing business id" });
        }

        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return res.status(400).json({ error: "Invalid or missing date (YYYY-MM-DD)" });
        }

        if (!worker || !isValidObjectId(worker)) {
            return res.status(400).json({ error: "Missing or invalid worker id" });
        }

        const { start, end } = utcDayRange(date);

        const appts = await AppointmentModel.find({
            business,
            worker,
            start: { $lt: end },
            $expr: {
                $gt: [
                    { $add: ["$start", { $multiply: ["$service.duration", 60000] }] },
                    start
                ]
            }
        })
            .sort({ start: 1 })
            .populate("business", "name address phone")
            .populate("worker", "name fullName phone")
            .populate("client", "name phone") // ⭐️ חשוב לאדמין
            .lean()
            .exec();

        return res.json(appts);
    } catch (err) {
        console.error(err);
        return res.status(502).json({ error: "Server error" });
    }
});

/**
 * ------------------------------------------------------------------
 * GET /appointments/my  (משתמש רגיל – "התורים שלך")
 * ------------------------------------------------------------------
 */
router.get("/my", auth, async (req, res) => {
    try {
        const { _id: clientId, business } = req.tokenData;
        const { statuses, includePast } = req.query;

        if (!isValidObjectId(clientId) || !isValidObjectId(business)) {
            return res.status(400).json({ error: "Invalid token data" });
        }

        let statusFilter = undefined;
        if (typeof statuses === "string" && statuses.trim()) {
            const arr = statuses
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);

            if (arr.length > 0) statusFilter = arr;
        }

        const includePastBool = includePast === "true";
        const now = new Date();

        const query = {
            business,
            client: clientId
        };

        if (statusFilter) {
            query.status = { $in: statusFilter };
        }

        if (!includePastBool) {
            query.start = { $gte: now };
        }

        const appts = await AppointmentModel.find(query)
            .sort({ start: 1 })
            .populate("business", "name address phone")
            .populate("worker", "name fullName")
            .lean()
            .exec();

        return res.json(appts);
    } catch (err) {
        console.error("❌ Error in GET /appointments/my:", err);
        return res.status(502).json({ error: "Server error" });
    }
});

/**
 * ------------------------------------------------------------------
 * POST /appointments
 * יצירת תור
 * ------------------------------------------------------------------
 */
router.post("/", auth, async (req, res) => {
    const { business } = req.tokenData;

    const payload = { ...req.body, business };
    const { error, value } = validateAppointment(payload);

    if (error) {
        return res.status(400).json({
            error: error.details?.[0]?.message || "Validation error"
        });
    }

    const { client, worker, service, start, notes } = value;

    if (
        !isValidObjectId(business) ||
        !isValidObjectId(client) ||
        !isValidObjectId(worker)
    ) {
        return res.status(400).json({ error: "Invalid business/client/worker id" });
    }

    try {
        // בדיקה שהלקוח והעובד שייכים לעסק
        const user = await UserModel.findOne({ _id: client, business }).lean();
        if (!user) {
            return res.status(400).json({ error: "Client does not belong to this business" });
        }

        const workerDoc = await UserModel.findOne({ _id: worker, business }).lean();
        if (!workerDoc) {
            return res.status(400).json({ error: "Worker does not belong to this business" });
        }

        /**
         * ⭐ NEW: היוזר לא יכול לקבוע אם יש לו כבר 3 תורים מאושרים
         */
        const confirmedCount = await AppointmentModel.countDocuments({
            business,
            client,
            status: "confirmed"
        });

        if (confirmedCount >= 3) {
            return res.status(403).json({
                error: "MAX_CONFIRMED_REACHED",
                message: "לא ניתן לקבוע יותר מ3 תורים במצב מאושר."
            });
        }

        const startDate = new Date(start);
        const endDate = new Date(startDate.getTime() + minutesToMs(service.duration));

        // בדיקת חפיפה עם תור אחר
        const overlapping = await AppointmentModel.findOne({
            business,
            worker,
            status: { $in: BLOCKING_STATUSES },
            $expr: {
                $and: [
                    { $lt: ["$start", endDate] },
                    {
                        $gt: [
                            { $add: ["$start", { $multiply: ["$service.duration", 60000] }] },
                            startDate
                        ]
                    }
                ]
            }
        }).lean();

        if (overlapping) {
            return res.status(409).json({ error: "SLOT_TAKEN" });
        }

        // יצירה בפועל
        const doc = await AppointmentModel.create({
            business,
            client,
            worker,
            service,
            start: startDate,
            status: "confirmed",
            notes: notes || "",
            createdAt: new Date()
        });

        return res.status(201).json(doc);
    } catch (err) {
        console.error("❌ Error in POST /appointments:", err);
        return res.status(500).json({ error: "Server error" });
    }
});


/**
 * ------------------------------------------------------------------
 * PATCH /appointments/:id/status (אדמין)
 * ------------------------------------------------------------------
 */
const statusSchema = Joi.object({
    status: Joi.string()
        .valid("confirmed", "canceled", "completed", "no_show")
        .required(),
    notes: Joi.string().max(1000).allow("", null)
});

router.patch("/:id/status", authAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { business } = req.tokenData;

        if (!isValidObjectId(id)) {
            return res.status(400).json({ error: "Invalid appointment id" });
        }

        const appt = await AppointmentModel.findOne({ _id: id, business }).lean();
        if (!appt) {
            return res.status(404).json({ error: "Appointment not found" });
        }

        const { error, value } = statusSchema.validate(req.body);
        if (error) {
            return res.status(400).json({
                error: error.details?.[0]?.message || "Validation error"
            });
        }

        const { status } = value;

        if (status === "confirmed") {
            const startDate = new Date(appt.start);
            const endDate = new Date(
                startDate.getTime() + minutesToMs(appt.service.duration)
            );

            const conflict = await AppointmentModel.findOne({
                _id: { $ne: appt._id },
                business: appt.business,
                worker: appt.worker,
                status: { $in: BLOCKING_STATUSES },
                $expr: {
                    $and: [
                        { $lt: ["$start", endDate] },
                        {
                            $gt: [
                                { $add: ["$start", { $multiply: ["$service.duration", 60000] }] },
                                startDate
                            ]
                        }
                    ]
                }
            }).lean();

            if (conflict) {
                return res.status(409).json({ error: "SLOT_TAKEN" });
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

        return res.json(updated);
    } catch (err) {
        console.error(err);
        return res.status(502).json({ error: "Server error" });
    }
});

/**
 * ------------------------------------------------------------------
 * PATCH /appointments/:id/cancel (משתמש)
 * ------------------------------------------------------------------
 */
const HOURS_24_MS = 24 * 60 * 60 * 1000;

router.patch("/:id/cancel", auth, async (req, res) => {
    try {
        const { id } = req.params;
        const { _id: clientId, business } = req.tokenData;

        if (!isValidObjectId(id)) {
            return res.status(400).json({ error: "Invalid appointment id" });
        }

        if (!isValidObjectId(clientId) || !isValidObjectId(business)) {
            return res.status(400).json({ error: "Invalid token data" });
        }

        const appt = await AppointmentModel.findOne({
            _id: id,
            client: clientId,
            business
        }).exec();

        if (!appt) {
            return res.status(404).json({ error: "Appointment not found" });
        }

        if (appt.status !== "confirmed") {
            return res.status(400).json({ error: "ONLY_CONFIRMED_CAN_BE_CANCELED" });
        }

        const now = new Date();
        const diffMs = appt.start.getTime() - now.getTime();

        if (diffMs < HOURS_24_MS) {
            return res.status(409).json({
                error: "CANNOT_CANCEL_WITHIN_24H"
            });
        }

        appt.status = "canceled";
        await appt.save();

        return res.json(appt);
    } catch (err) {
        console.error("❌ Error in PATCH /appointments/:id/cancel", err);
        return res.status(502).json({ error: "Server error" });
    }
});

module.exports = router;
