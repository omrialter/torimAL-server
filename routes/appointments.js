const express = require("express");
const mongoose = require("mongoose");
const Joi = require("joi");
const router = express.Router();

// Internal Imports
const { UserModel } = require("../models/userModel");
const { AppointmentModel, validateAppointment } = require("../models/appointmentModel");
const { auth, authAdmin } = require("../auth/auth");
const { sendPushToManyTokens } = require("../services/pushService");

// Constants
const BLOCKING_STATUSES = ["confirmed"];
const HOURS_24_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------
// Helpers & Utilities
// ---------------------------------------------------------

const minutesToMs = (min) => min * 60 * 1000;
const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

/**
 * Helper: Send push notifications to admins about appointment events
 */
async function notifyAdmins(businessId, eventType, title, body, data = {}) {
    try {
        const settingKeyByEvent = {
            appointment_created: "onAppointmentCreated",
            appointment_canceled: "onAppointmentCanceled",
            user_signup: "onUserSignup",
        };

        const settingKey = settingKeyByEvent[eventType];
        if (!settingKey) return { ok: false, error: "Unknown eventType" };

        const admins = await UserModel.find({
            business: businessId,
            role: "admin",
            expoPushToken: { $exists: true, $ne: null },
            "adminPushSettings.enabled": { $ne: false },
        }).select("expoPushToken adminPushSettings");

        const tokens = [
            ...new Set(
                admins
                    .filter((a) => a.adminPushSettings?.[settingKey] !== false)
                    .map((a) => a.expoPushToken)
                    .filter((t) => typeof t === "string" && t.trim().length > 0)
                    .map((t) => t.trim())
            ),
        ];

        if (tokens.length === 0) return { ok: true, sent: 0 };

        return await sendPushToManyTokens(tokens, title, body, {
            ...data,
            type: "admin_event",
            eventType,
            businessId: String(businessId),
            createdAt: new Date().toISOString(),
        });
    } catch (err) {
        console.error("notifyAdmins error:", err);
        return { ok: false };
    }
}

/**
 * Helper: Get UTC start and end for a specific date string (YYYY-MM-DD)
 */
function utcDayRange(dateStr) {
    const start = new Date(`${dateStr}T00:00:00.000Z`);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    return { start, end };
}

/**
 * Helper: Check for overlapping appointments
 * Returns the conflicting appointment if found, otherwise null.
 */
async function checkAppointmentOverlap(business, worker, start, durationMinutes, excludeId = null) {
    const startDate = new Date(start);
    const endDate = new Date(startDate.getTime() + minutesToMs(durationMinutes));

    const query = {
        business,
        worker,
        status: { $in: BLOCKING_STATUSES },
        $expr: {
            $and: [
                { $lt: ["$start", endDate] }, // Existing starts before new ends
                {
                    // Existing ends after new starts
                    $gt: [
                        { $add: ["$start", { $multiply: ["$service.duration", 60000] }] },
                        startDate,
                    ],
                },
            ],
        },
    };

    if (excludeId) {
        query._id = { $ne: excludeId };
    }

    return await AppointmentModel.findOne(query).lean();
}

// ---------------------------------------------------------
// Routes
// ---------------------------------------------------------

/**
 * GET /appointments/by-day
 * Fetch all appointments for a specific day and worker
 */
router.get("/by-day", auth, async (req, res) => {
    try {
        const { date, worker } = req.query;
        const { business } = req.tokenData;

        if (!isValidObjectId(business) || !isValidObjectId(worker)) {
            return res.status(400).json({ error: "Invalid business or worker ID" });
        }

        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return res.status(400).json({ error: "Invalid date format (YYYY-MM-DD)" });
        }

        const { start, end } = utcDayRange(date);

        // Find appointments that overlap with this day
        // (including those that started yesterday but spill into today)
        const appts = await AppointmentModel.find({
            business,
            worker,
            start: { $lt: end },
            $expr: {
                $gt: [
                    { $add: ["$start", { $multiply: ["$service.duration", 60000] }] },
                    start,
                ],
            },
        })
            .sort({ start: 1 })
            .populate("business", "name address phone")
            .populate("worker", "name fullName phone")
            .populate("client", "name phone")
            .lean();

        return res.json(appts);
    } catch (err) {
        console.error("GET /by-day error:", err);
        return res.status(502).json({ error: "Server error" });
    }
});

/**
 * GET /appointments/my
 * Fetch appointments for the logged-in client
 */
router.get("/my", auth, async (req, res) => {
    try {
        const { _id: clientId, business } = req.tokenData;
        const { statuses, includePast } = req.query;

        if (!isValidObjectId(clientId) || !isValidObjectId(business)) {
            return res.status(400).json({ error: "Invalid token data" });
        }

        const query = { business, client: clientId };

        // Filter by Status
        if (statuses) {
            const arr = statuses.split(",").map((s) => s.trim()).filter(Boolean);
            if (arr.length > 0) query.status = { $in: arr };
        }

        // Filter Past Appointments
        if (includePast !== "true") {
            query.start = { $gte: new Date() };
        }

        const appts = await AppointmentModel.find(query)
            .sort({ start: 1 })
            .populate("business", "name address phone")
            .populate("worker", "name fullName")
            .lean();

        return res.json(appts);
    } catch (err) {
        console.error("GET /my error:", err);
        return res.status(502).json({ error: "Server error" });
    }
});

/**
 * GET /appointments/admin-stats
 * Returns simple counts for the admin dashboard
 */
router.get("/admin-stats", authAdmin, async (req, res) => {
    try {
        const { business } = req.tokenData;
        const { worker } = req.query;

        if (!isValidObjectId(business)) {
            return res.status(400).json({ error: "Invalid business ID" });
        }

        const baseFilter = {
            business,
            status: { $ne: "canceled" },
        };

        if (worker && isValidObjectId(worker)) {
            baseFilter.worker = worker;
        }

        const now = new Date();
        const todayStr = now.toISOString().slice(0, 10);
        const { start: todayStart, end: todayEnd } = utcDayRange(todayStr);

        const [todayCount, futureCount] = await Promise.all([
            AppointmentModel.countDocuments({
                ...baseFilter,
                start: { $gte: todayStart, $lt: todayEnd },
            }),
            AppointmentModel.countDocuments({
                ...baseFilter,
                start: { $gte: now },
            }),
        ]);

        return res.json({ todayCount, futureCount });
    } catch (err) {
        console.error("GET /admin-stats error:", err);
        return res.status(502).json({ error: "Server error" });
    }
});

/**
 * GET /appointments/nearest-slots
 * Algorithm to find the next 5 available slots
 */
router.get("/nearest-slots", auth, async (req, res) => {
    try {
        const { business } = req.tokenData;
        const { worker, duration } = req.query;

        if (!isValidObjectId(business) || !isValidObjectId(worker)) {
            return res.status(400).json({ error: "Invalid IDs" });
        }

        const serviceDurationMin = parseInt(duration) || 30;
        const neededMs = minutesToMs(serviceDurationMin);

        // TODO: Move these constants to the BusinessModel in the database
        const WORK_START_HOUR = 8;
        const WORK_END_HOUR = 20;
        const SLOT_INTERVAL_MIN = 20;

        let foundSlots = [];
        let dateIterator = new Date(); // Start searching from now

        // If currently after work hours, skip to tomorrow morning
        if (dateIterator.getHours() >= WORK_END_HOUR) {
            dateIterator.setDate(dateIterator.getDate() + 1);
            dateIterator.setHours(WORK_START_HOUR, 0, 0, 0);
        }

        let daysChecked = 0;
        const MAX_DAYS_CHECK = 14; // Prevent infinite loops

        while (foundSlots.length < 5 && daysChecked < MAX_DAYS_CHECK) {
            // 1. Define day range
            let dayStart = new Date(dateIterator);
            if (dayStart.getHours() < WORK_START_HOUR) {
                dayStart.setHours(WORK_START_HOUR, 0, 0, 0);
            }

            let dayEnd = new Date(dateIterator);
            dayEnd.setHours(WORK_END_HOUR, 0, 0, 0);

            // If day is already over, skip
            if (dayStart >= dayEnd) {
                dateIterator.setDate(dateIterator.getDate() + 1);
                dateIterator.setHours(WORK_START_HOUR, 0, 0, 0);
                daysChecked++;
                continue;
            }

            // 2. Fetch existing appointments for this day
            const appointmentsToday = await AppointmentModel.find({
                business,
                worker,
                status: { $in: BLOCKING_STATUSES },
                start: { $gte: dayStart, $lt: dayEnd },
            })
                .select("start service.duration")
                .lean();

            // 3. Scan slots within the day
            let currentSlot = new Date(dayStart);

            while (currentSlot < dayEnd && foundSlots.length < 5) {
                const slotEnd = new Date(currentSlot.getTime() + neededMs);

                // Slot exceeds working hours
                if (slotEnd > dayEnd) break;

                // Check overlap
                const isTaken = appointmentsToday.some((appt) => {
                    const apptStart = new Date(appt.start);
                    const apptEnd = new Date(
                        apptStart.getTime() + minutesToMs(appt.service.duration)
                    );
                    return currentSlot < apptEnd && slotEnd > apptStart;
                });

                if (!isTaken) {
                    foundSlots.push(new Date(currentSlot));
                }

                // Advance
                currentSlot = new Date(currentSlot.getTime() + minutesToMs(SLOT_INTERVAL_MIN));
            }

            // Next day
            dateIterator.setDate(dateIterator.getDate() + 1);
            dateIterator.setHours(WORK_START_HOUR, 0, 0, 0);
            daysChecked++;
        }

        return res.json({ slots: foundSlots });
    } catch (err) {
        console.error("Error finding nearest slots:", err);
        return res.status(500).json({ error: "Server error" });
    }
});

/**
 * POST /appointments
 * Create a new appointment
 */
router.post("/", auth, async (req, res) => {
    const { business } = req.tokenData;
    const payload = { ...req.body, business };

    // 1. Validation
    const { error, value } = validateAppointment(payload);
    if (error) {
        return res.status(400).json({
            error: error.details?.[0]?.message || "Validation error",
        });
    }

    const { client, worker, service, start, notes } = value;

    if (!isValidObjectId(client) || !isValidObjectId(worker)) {
        return res.status(400).json({ error: "Invalid client or worker ID" });
    }

    try {
        // 2. Ownership Checks
        const [clientUser, workerUser] = await Promise.all([
            UserModel.findOne({ _id: client, business }).lean(),
            UserModel.findOne({ _id: worker, business }).lean(),
        ]);

        if (!clientUser) return res.status(400).json({ error: "Client not found in business" });
        if (!workerUser) return res.status(400).json({ error: "Worker not found in business" });

        // 3. Max Confirmed Check (Logic restriction)
        const confirmedCount = await AppointmentModel.countDocuments({
            business,
            client,
            status: "confirmed",
        });

        if (confirmedCount >= 3) {
            return res.status(403).json({
                error: "MAX_CONFIRMED_REACHED",
                message: "Limit reached: You have 3 active appointments.",
            });
        }

        // 4. Overlap Check
        const overlap = await checkAppointmentOverlap(
            business,
            worker,
            start,
            service.duration
        );

        if (overlap) return res.status(409).json({ error: "SLOT_TAKEN" });

        // 5. Create
        const doc = await AppointmentModel.create({
            business,
            client,
            worker,
            service,
            start,
            status: "confirmed",
            notes: notes || "",
        });

        // 6. Notify Admins (Async)
        notifyAdmins(
            business,
            "appointment_created",
            "New Appointment",
            `New appointment at ${new Date(start).toLocaleTimeString("he-IL")}`,
            { appointmentId: String(doc._id) }
        ).catch((e) => console.error("Notify failed:", e));

        return res.status(201).json(doc);
    } catch (err) {
        console.error("POST /appointments error:", err);
        return res.status(500).json({ error: "Server error" });
    }
});

/**
 * PATCH /appointments/:id/status
 * Admin: Update status
 */
const statusSchema = Joi.object({
    status: Joi.string().valid("confirmed", "canceled", "completed", "no_show").required(),
    notes: Joi.string().max(1000).allow("", null),
});

router.patch("/:id/status", authAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { business } = req.tokenData;

        if (!isValidObjectId(id)) return res.status(400).json({ error: "Invalid ID" });

        const appt = await AppointmentModel.findOne({ _id: id, business }).lean();
        if (!appt) return res.status(404).json({ error: "Appointment not found" });

        const { error, value } = statusSchema.validate(req.body);
        if (error) return res.status(400).json({ error: error.details?.[0]?.message });

        // Re-check overlap if setting to confirmed
        if (value.status === "confirmed" && appt.status !== "confirmed") {
            const overlap = await checkAppointmentOverlap(
                business,
                appt.worker,
                appt.start,
                appt.service.duration,
                appt._id // Exclude self
            );
            if (overlap) return res.status(409).json({ error: "SLOT_TAKEN" });
        }

        const updated = await AppointmentModel.findOneAndUpdate(
            { _id: id, business },
            {
                status: value.status,
                ...(value.notes ? { notes: value.notes } : {}),
            },
            { new: true }
        ).exec();

        // Notify if canceled by admin
        if (value.status === "canceled") {
            notifyAdmins(
                business,
                "appointment_canceled",
                "Appointment Canceled",
                "An appointment was canceled by admin",
                { appointmentId: String(updated._id) }
            ).catch((e) => console.error("Notify failed:", e));
        }

        return res.json(updated);
    } catch (err) {
        console.error("PATCH status error:", err);
        return res.status(502).json({ error: "Server error" });
    }
});

/**
 * PATCH /appointments/:id/cancel
 * Client: Cancel appointment (24h restriction)
 */
router.patch("/:id/cancel", auth, async (req, res) => {
    try {
        const { id } = req.params;
        const { _id: clientId, business } = req.tokenData;

        if (!isValidObjectId(id)) return res.status(400).json({ error: "Invalid ID" });

        const appt = await AppointmentModel.findOne({
            _id: id,
            client: clientId,
            business,
        });

        if (!appt) return res.status(404).json({ error: "Appointment not found" });
        if (appt.status !== "confirmed") {
            return res.status(400).json({ error: "ONLY_CONFIRMED_CAN_BE_CANCELED" });
        }

        const diffMs = new Date(appt.start).getTime() - Date.now();
        if (diffMs < HOURS_24_MS) {
            return res.status(409).json({ error: "CANNOT_CANCEL_WITHIN_24H" });
        }

        appt.status = "canceled";
        await appt.save();

        notifyAdmins(
            business,
            "appointment_canceled",
            "Client Canceled Appointment",
            `A client canceled an appointment`,
            { appointmentId: String(appt._id) }
        ).catch((e) => console.error("Notify failed:", e));

        return res.json(appt);
    } catch (err) {
        console.error("PATCH cancel error:", err);
        return res.status(502).json({ error: "Server error" });
    }
});

module.exports = router;