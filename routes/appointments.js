// routes/appointments.js
const express = require("express");
const mongoose = require("mongoose");
const Joi = require("joi");
const { UserModel } = require("../models/userModel");
const { AppointmentModel, validateAppointment } = require("../models/appointmentModel");
const { auth, authAdmin } = require("../auth/auth");
const { sendPushToManyTokens } = require("../services/pushService");

const router = express.Router();

const BLOCKING_STATUSES = ["confirmed"];
const minutesToMs = (min) => min * 60 * 1000;
const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

// -------------------------
// Admin Push Notify Helper
// -------------------------
async function notifyAdmins(businessId, eventType, title, body, data = {}) {
    const settingKeyByEvent = {
        appointment_created: "onAppointmentCreated",
        appointment_canceled: "onAppointmentCanceled",
        user_signup: "onUserSignup",
    };

    const key = settingKeyByEvent[eventType];
    if (!key) return { ok: false, error: "Unknown eventType" };

    const admins = await UserModel.find({
        business: businessId,
        role: "admin",
        expoPushToken: { $exists: true, $ne: null },
        "adminPushSettings.enabled": { $ne: false },
    }).select("expoPushToken adminPushSettings");

    const tokens = Array.from(
        new Set(
            admins
                .filter((a) => a.adminPushSettings?.[key] !== false)
                .map((a) => a.expoPushToken)
                .filter((t) => typeof t === "string" && t.trim().length > 0)
                .map((t) => t.trim())
        )
    );

    if (tokens.length === 0) return { ok: true, sent: 0 };

    return sendPushToManyTokens(tokens, title, body, {
        ...data,
        type: "admin_event",
        eventType,
        businessId: String(businessId),
        createdAt: new Date().toISOString(),
    });
}

/**
 * עוזר - טווח יום UTC
 */
function utcDayRange(dateStr) {
    const start = new Date(`${dateStr}T00:00:00.000Z`);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    return { start, end };
}

/**
 * GET /appointments/by-day
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
                $gt: [{ $add: ["$start", { $multiply: ["$service.duration", 60000] }] }, start],
            },
        })
            .sort({ start: 1 })
            .populate("business", "name address phone")
            .populate("worker", "name fullName phone")
            .populate("client", "name phone")
            .lean()
            .exec();

        return res.json(appts);
    } catch (err) {
        console.error(err);
        return res.status(502).json({ error: "Server error" });
    }
});

/**
 * GET /appointments/my
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

        const query = { business, client: clientId };

        if (statusFilter) query.status = { $in: statusFilter };
        if (!includePastBool) query.start = { $gte: now };

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
 * GET /appointments/admin-stats
 */
router.get("/admin-stats", authAdmin, async (req, res) => {
    try {
        const { business } = req.tokenData;
        const { worker } = req.query;

        if (!business || !isValidObjectId(business)) {
            return res.status(400).json({ error: "Invalid or missing business id" });
        }

        const baseFilter = {
            business,
            status: { $ne: "canceled" },
        };

        if (worker) {
            if (!isValidObjectId(worker)) {
                return res.status(400).json({ error: "Invalid worker id" });
            }
            baseFilter.worker = worker;
        }

        const now = new Date();
        const todayStr = now.toISOString().slice(0, 10);
        const { start: todayStart, end: todayEnd } = utcDayRange(todayStr);

        const [todayCount, futureCount] = await Promise.all([
            AppointmentModel.countDocuments({ ...baseFilter, start: { $gte: todayStart, $lt: todayEnd } }),
            AppointmentModel.countDocuments({ ...baseFilter, start: { $gte: now } }),
        ]);

        return res.json({ todayCount, futureCount });
    } catch (err) {
        console.error("❌ Error in GET /appointments/admin-stats:", err);
        return res.status(502).json({ error: "Server error" });
    }
});


/**
 * GET /appointments/nearest-slots
 * חיפוש 5 התורים הפנויים הקרובים ביותר
 */
router.get("/nearest-slots", auth, async (req, res) => {
    try {
        const { business } = req.tokenData;
        const { worker, duration } = req.query;

        // ולידציות בסיסיות
        if (!isValidObjectId(business) || !isValidObjectId(worker)) {
            return res.status(400).json({ error: "Invalid IDs" });
        }

        const serviceDurationMin = parseInt(duration) || 30; // ברירת מחדל 30 דקות
        const neededMs = minutesToMs(serviceDurationMin);

        // הגדרות עבודה (בפועל - לשלוף מה-BusinessModel)
        const WORK_START_HOUR = 8;
        const WORK_END_HOUR = 20;
        const SLOT_INTERVAL_MIN = 20; // קפיצות של 20 דקות בחיפוש

        let foundSlots = [];
        let dateIterator = new Date(); // מתחילים מעכשיו

        // אם עכשיו אחרי שעות העבודה, נתחיל ממחר בבוקר
        if (dateIterator.getHours() >= WORK_END_HOUR) {
            dateIterator.setDate(dateIterator.getDate() + 1);
            dateIterator.setHours(WORK_START_HOUR, 0, 0, 0);
        }

        // הגנה: לא לחפש יותר מ-14 יום קדימה כדי לא להיתקע בלולאה
        let daysChecked = 0;

        while (foundSlots.length < 5 && daysChecked < 14) {

            // 1. הגדרת טווח החיפוש לאותו יום ספציפי
            let dayStart = new Date(dateIterator);
            if (dayStart.getHours() < WORK_START_HOUR) {
                dayStart.setHours(WORK_START_HOUR, 0, 0, 0);
            }

            let dayEnd = new Date(dateIterator);
            dayEnd.setHours(WORK_END_HOUR, 0, 0, 0);

            // אם כבר עברנו את סוף היום הנוכחי, נדלג ליום הבא
            if (dayStart >= dayEnd) {
                dateIterator.setDate(dateIterator.getDate() + 1);
                dateIterator.setHours(WORK_START_HOUR, 0, 0, 0);
                daysChecked++;
                continue;
            }

            // 2. שליפת כל התורים הקיימים לאותו יום
            // אופטימיזציה: שולפים רק את ה-start וה-duration
            const appointmentsToday = await AppointmentModel.find({
                business,
                worker,
                status: { $in: BLOCKING_STATUSES },
                start: { $gte: dayStart, $lt: dayEnd }
            }).select('start service.duration').lean();

            // 3. לולאה פנימית על השעות ביום
            let currentSlot = new Date(dayStart);

            while (currentSlot < dayEnd && foundSlots.length < 5) {
                const slotEnd = new Date(currentSlot.getTime() + neededMs);

                // אם התור חורג משעות הפעילות
                if (slotEnd > dayEnd) break;

                // בדיקת התנגשות
                const isTaken = appointmentsToday.some(appt => {
                    const apptStart = new Date(appt.start);
                    const apptEnd = new Date(apptStart.getTime() + minutesToMs(appt.service.duration));

                    // בדיקת חפיפה קלאסית
                    return (currentSlot < apptEnd && slotEnd > apptStart);
                });

                if (!isTaken) {
                    foundSlots.push(new Date(currentSlot)); // מצאנו תור!
                }

                // מתקדמים ב-30 דקות (או כל אינטרוול שתבחר)
                currentSlot = new Date(currentSlot.getTime() + minutesToMs(SLOT_INTERVAL_MIN));
            }

            // קידום ליום הבא
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
 * יצירת תור
 */
router.post("/", auth, async (req, res) => {
    const { business } = req.tokenData;

    const payload = { ...req.body, business };
    const { error, value } = validateAppointment(payload);

    if (error) {
        return res.status(400).json({
            error: error.details?.[0]?.message || "Validation error",
        });
    }

    const { client, worker, service, start, notes } = value;

    if (!isValidObjectId(business) || !isValidObjectId(client) || !isValidObjectId(worker)) {
        return res.status(400).json({ error: "Invalid business/client/worker id" });
    }

    try {
        const user = await UserModel.findOne({ _id: client, business }).lean();
        if (!user) return res.status(400).json({ error: "Client does not belong to this business" });

        const workerDoc = await UserModel.findOne({ _id: worker, business }).lean();
        if (!workerDoc) return res.status(400).json({ error: "Worker does not belong to this business" });

        const confirmedCount = await AppointmentModel.countDocuments({
            business,
            client,
            status: "confirmed",
        });

        if (confirmedCount >= 3) {
            return res.status(403).json({
                error: "MAX_CONFIRMED_REACHED",
                message: "לא ניתן לקבוע יותר מ3 תורים במצב מאושר.",
            });
        }

        const startDate = new Date(start);
        const endDate = new Date(startDate.getTime() + minutesToMs(service.duration));

        const overlapping = await AppointmentModel.findOne({
            business,
            worker,
            status: { $in: BLOCKING_STATUSES },
            $expr: {
                $and: [
                    { $lt: ["$start", endDate] },
                    {
                        $gt: [{ $add: ["$start", { $multiply: ["$service.duration", 60000] }] }, startDate],
                    },
                ],
            },
        }).lean();

        if (overlapping) return res.status(409).json({ error: "SLOT_TAKEN" });

        const doc = await AppointmentModel.create({
            business,
            client,
            worker,
            service,
            start: startDate,
            status: "confirmed",
            notes: notes || "",
            createdAt: new Date(),
        });

        // ✅ Push לאדמינים על תור חדש (לא מפיל יצירת תור אם נכשל)
        try {
            const startIso = new Date(doc.start).toISOString();
            await notifyAdmins(
                business,
                "appointment_created",
                "נקבע תור חדש",
                `נקבע תור חדש ב-${startIso.slice(0, 10)} ${startIso.slice(11, 16)}`,
                { appointmentId: String(doc._id) }
            );
        } catch (e) {
            console.error("notifyAdmins(appointment_created) failed:", e);
        }

        return res.status(201).json(doc);
    } catch (err) {
        console.error("❌ Error in POST /appointments:", err);
        return res.status(500).json({ error: "Server error" });
    }
});

/**
 * PATCH /appointments/:id/status (אדמין)
 */
const statusSchema = Joi.object({
    status: Joi.string().valid("confirmed", "canceled", "completed", "no_show").required(),
    notes: Joi.string().max(1000).allow("", null),
});

router.patch("/:id/status", authAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { business } = req.tokenData;

        if (!isValidObjectId(id)) return res.status(400).json({ error: "Invalid appointment id" });

        const appt = await AppointmentModel.findOne({ _id: id, business }).lean();
        if (!appt) return res.status(404).json({ error: "Appointment not found" });

        const { error, value } = statusSchema.validate(req.body);
        if (error) {
            return res.status(400).json({ error: error.details?.[0]?.message || "Validation error" });
        }

        const { status } = value;

        if (status === "confirmed") {
            const startDate = new Date(appt.start);
            const endDate = new Date(startDate.getTime() + minutesToMs(appt.service.duration));

            const conflict = await AppointmentModel.findOne({
                _id: { $ne: appt._id },
                business: appt.business,
                worker: appt.worker,
                status: { $in: BLOCKING_STATUSES },
                $expr: {
                    $and: [
                        { $lt: ["$start", endDate] },
                        {
                            $gt: [{ $add: ["$start", { $multiply: ["$service.duration", 60000] }] }, startDate],
                        },
                    ],
                },
            }).lean();

            if (conflict) return res.status(409).json({ error: "SLOT_TAKEN" });
        }

        const updated = await AppointmentModel.findOneAndUpdate(
            { _id: id, business },
            {
                status: value.status,
                ...(value.notes ? { notes: value.notes } : {}),
            },
            { new: true }
        ).exec();

        // אם אדמין שינה ל-canceled – גם זה “ביטול תור”
        if (value.status === "canceled") {
            try {
                const startIso = new Date(updated.start).toISOString();
                await notifyAdmins(
                    business,
                    "appointment_canceled",
                    "תור בוטל",
                    `תור ב-${startIso.slice(0, 10)} ${startIso.slice(11, 16)} בוטל`,
                    { appointmentId: String(updated._id) }
                );
            } catch (e) {
                console.error("notifyAdmins(appointment_canceled via admin) failed:", e);
            }
        }

        return res.json(updated);
    } catch (err) {
        console.error(err);
        return res.status(502).json({ error: "Server error" });
    }
});

/**
 * PATCH /appointments/:id/cancel (משתמש)
 */
const HOURS_24_MS = 24 * 60 * 60 * 1000;

router.patch("/:id/cancel", auth, async (req, res) => {
    try {
        const { id } = req.params;
        const { _id: clientId, business } = req.tokenData;

        if (!isValidObjectId(id)) return res.status(400).json({ error: "Invalid appointment id" });
        if (!isValidObjectId(clientId) || !isValidObjectId(business)) {
            return res.status(400).json({ error: "Invalid token data" });
        }

        const appt = await AppointmentModel.findOne({
            _id: id,
            client: clientId,
            business,
        }).exec();

        if (!appt) return res.status(404).json({ error: "Appointment not found" });
        if (appt.status !== "confirmed") {
            return res.status(400).json({ error: "ONLY_CONFIRMED_CAN_BE_CANCELED" });
        }

        const now = new Date();
        const diffMs = appt.start.getTime() - now.getTime();
        if (diffMs < HOURS_24_MS) {
            return res.status(409).json({ error: "CANNOT_CANCEL_WITHIN_24H" });
        }

        appt.status = "canceled";
        await appt.save();

        // ✅ Push לאדמינים על ביטול תור (לא מפיל ביטול אם נכשל)
        try {
            const startIso = new Date(appt.start).toISOString();
            await notifyAdmins(
                business,
                "appointment_canceled",
                "תור בוטל",
                `תור ב-${startIso.slice(0, 10)} ${startIso.slice(11, 16)} בוטל`,
                { appointmentId: String(appt._id) }
            );
        } catch (e) {
            console.error("notifyAdmins(appointment_canceled) failed:", e);
        }

        return res.json(appt);
    } catch (err) {
        console.error("❌ Error in PATCH /appointments/:id/cancel", err);
        return res.status(502).json({ error: "Server error" });
    }
});

module.exports = router;
