// routes/businesses.js
const express = require("express");
const mongoose = require("mongoose");
const Joi = require("joi");
const { BusinessModel, validateBusiness } = require("../models/businessModel.js");
const { UserModel } = require("../models/userModel");
const { AppointmentModel } = require("../models/appointmentModel");
const { auth, authAdmin } = require("../auth/auth.js");
const cloudinary = require("cloudinary").v2;
const streamifier = require("streamifier");
const multer = require("multer");

const router = express.Router();

/* ======================================================
   🌥 CLOUDINARY CONFIG
====================================================== */
cloudinary.config({
    cloud_name: process.env.CLOUD_NAME,
    api_key: process.env.CLOUD_KEY,
    api_secret: process.env.CLOUD_SECRET,
    timeout: 600000, // מאפשר העלאות וידאו/קבצים גדולים
});

console.log("✅ Cloudinary configured:", process.env.CLOUD_NAME);

/* ======================================================
   📦 MULTER — הגבלת 50MB
====================================================== */
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

/* ======================================================
   ☁️ העלאה רגילה (תמונות / קבצים קטנים)
====================================================== */
function uploadToCloudinary(buffer, folder, resourceType = "auto") {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            { folder, resource_type: resourceType },
            (error, result) => {
                if (error) return reject(error);
                resolve(result);
            }
        );

        stream.end(buffer);
    });
}

/* ======================================================
   ☁️ העלאה גדולה (בעיקר וידאו)
====================================================== */
function uploadLargeToCloudinary(buffer, folder, resourceType = "video") {
    return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
            {
                resource_type: resourceType,
                folder,
                chunk_size: 6_000_000,
            },
            (error, result) => {
                if (error) return reject(error);
                resolve(result);
            }
        );

        streamifier.createReadStream(buffer).pipe(uploadStream);
    });
}

/* ======================================================
   🆔 שליפת public_id מתוך URL
====================================================== */
function getCloudinaryPublicId(url) {
    try {
        const u = new URL(url);
        const parts = u.pathname.split("/").filter(Boolean);

        const uploadIndex = parts.indexOf("upload");
        if (uploadIndex === -1) return null;

        let publicIdParts = parts.slice(uploadIndex + 1);

        if (
            publicIdParts[0]?.startsWith("v") &&
            /^\d+$/.test(publicIdParts[0].slice(1))
        ) {
            publicIdParts = publicIdParts.slice(1);
        }

        const joined = publicIdParts.join("/");
        const dot = joined.lastIndexOf(".");
        return dot === -1 ? joined : joined.substring(0, dot);
    } catch {
        return null;
    }
}

/* ======================================================
   🔍 ניחוש סוג קובץ לפי סיומת
====================================================== */
function guessResourceTypeFromUrl(url) {
    const ext = url.split(".").pop()?.toLowerCase();
    const VIDEO_EXTS = ["mp4", "mov", "webm", "avi", "mkv"];
    return VIDEO_EXTS.includes(ext) ? "video" : "image";
}

/* ======================================================
   🎨 COLOR PRESETS + Joi
====================================================== */
const COLOR_PRESETS = {
    professional: {
        primary: "#1d4ed8",
        secondary: "#f3f4f6",
        third: "#0b1120",
    },
    midnight: {
        primary: "#0ea5e9",
        secondary: "#0f172a",
        third: "#f8fafc",
    },
    forest: {
        primary: "#065f46",
        secondary: "#e6f4f1",
        third: "#0b2722",
    },
    sunset: {
        primary: "#ea580c",
        secondary: "#fff7ed",
        third: "#7c2d12",
    },
    royal: {
        primary: "#7c3aed",
        secondary: "#f3e8ff",
        third: "#2e1065",
    },
};

const colorsPresetSchema = Joi.object({
    preset: Joi.string()
        .valid(...Object.keys(COLOR_PRESETS))
        .required(),
});

/* Joi קטן לטקסטים */
const messageSchema = Joi.object({
    message: Joi.string().max(4000).allow("").required(),
});

const aboutUsSchema = Joi.object({
    aboutUs: Joi.string().max(8000).allow("").required(),
});

const addressSchema = Joi.object({
    address: Joi.string().max(300).allow("").required(),
});

/* Joi לשעות עבודה */
const timeRangeSchema = Joi.object({
    open: Joi.string()
        .allow(null)
        .pattern(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/)
        .allow(""),
    close: Joi.string()
        .allow(null)
        .pattern(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/)
        .allow(""),
});

const openingHoursSchema = Joi.object({
    openingHours: Joi.object({
        sunday: timeRangeSchema,
        monday: timeRangeSchema,
        tuesday: timeRangeSchema,
        wednesday: timeRangeSchema,
        thursday: timeRangeSchema,
        friday: timeRangeSchema,
        saturday: timeRangeSchema,
    }).required(),
});

/* Joi לשירותים */
const serviceBodySchema = Joi.object({
    name: Joi.string().min(1).max(100).required(),
    duration: Joi.number().min(1).max(480).required(),
    price: Joi.number().min(0).required(),
});

const serviceUpdateSchema = Joi.object({
    name: Joi.string().min(1).max(100),
    duration: Joi.number().min(1).max(480),
    price: Joi.number().min(0),
}).min(1);

/* ======================================================
   🟢 HEALTH CHECK
====================================================== */
router.get("/", async (req, res) => {
    res.json({ msg: "Businesses works" });
});

/* ======================================================
   📌 GET BUSINESS INFO
====================================================== */
router.get("/businessInfo/:id", auth, async (req, res) => {
    const id = (req.params.id ?? "").trim();

    if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ error: "Invalid business id" });
    }

    const { business } = req.tokenData;

    if (business && business !== id) {
        return res.status(403).json({ error: "Access denied – wrong business" });
    }

    try {
        const doc = await BusinessModel.findById(id)
            .populate("owner", "_id name phone avatarUrl")
            .populate("workers", "_id name phone avatarUrl")
            .lean();

        if (!doc) return res.status(404).json({ error: "Business not found" });

        res.json(doc);
    } catch (err) {
        console.error("GET /businessInfo error:", err);
        res.status(500).json({ error: "Server error" });
    }
});

/* ======================================================
   📊 GET BUSINESS STATISTICS (מעודכן ל-No Show)
====================================================== */
router.get("/:id/stats", authAdmin, async (req, res) => {
    try {
        const businessId = (req.params.id ?? "").trim();
        const { business } = req.tokenData;

        if (!mongoose.Types.ObjectId.isValid(businessId)) {
            return res.status(400).json({ error: "Invalid business id" });
        }
        if (business && business !== businessId) {
            return res.status(403).json({ error: "Access denied" });
        }

        const now = new Date();
        const startOfCurrentMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const threeMonthsAgo = new Date();
        threeMonthsAgo.setMonth(now.getMonth() - 3);

        const [
            totalClients,
            completedThisMonth,
            noShowThisMonth, // שונה מ-canceled
            completedLastMonth,
            noShowLastMonth, // שונה מ-canceled
            activeUsersLast3Months
        ] = await Promise.all([
            // 1. סה"כ לקוחות
            UserModel.countDocuments({ business: businessId, role: "user" }),

            // 2. הושלמו החודש
            AppointmentModel.countDocuments({
                business: businessId,
                status: "completed",
                start: { $gte: startOfCurrentMonth }
            }),

            // 3. הברזות החודש (שונה מ-canceled ל-no_show)
            AppointmentModel.countDocuments({
                business: businessId,
                status: "no_show",
                start: { $gte: startOfCurrentMonth }
            }),

            // 4. הושלמו חודש שעבר
            AppointmentModel.countDocuments({
                business: businessId,
                status: "completed",
                start: { $gte: startOfLastMonth, $lt: startOfCurrentMonth }
            }),

            // 5. הברזות חודש שעבר (שונה מ-canceled ל-no_show)
            AppointmentModel.countDocuments({
                business: businessId,
                status: "no_show",
                start: { $gte: startOfLastMonth, $lt: startOfCurrentMonth }
            }),

            // 6. משתמשים פעילים
            AppointmentModel.distinct("client", {
                business: businessId,
                start: { $gte: threeMonthsAgo },
                status: { $ne: "canceled" }
            })
        ]);

        const activeCount = activeUsersLast3Months.length;
        const inactiveUsers = Math.max(0, totalClients - activeCount);

        res.json({
            totalClients,
            completedThisMonth,
            noShowThisMonth, // שם משתנה חדש
            completedLastMonth,
            noShowLastMonth, // שם משתנה חדש
            inactiveUsers,
        });

    } catch (err) {
        console.error("GET /:id/stats error:", err);
        res.status(500).json({ error: "Server error" });
    }
});

/* ======================================================
   🟩 POST NEW BUSINESS (admin only)
====================================================== */
router.post("/", authAdmin, async (req, res) => {
    const valid = validateBusiness(req.body);
    if (valid.error) return res.status(400).json(valid.error.details);

    try {
        const business = new BusinessModel(req.body);
        await business.save();
        res.json(business);
    } catch (err) {
        console.error("POST /business error:", err);
        if (err.code === 11000) {
            res.status(400).json({ msg: "business exists", code: 11000 });
        } else {
            res.status(500).json({ msg: "Server error", error: err.message });
        }
    }
});

/* ======================================================
   🌆 UPLOAD BANNER (IMAGE OR VIDEO)
====================================================== */
router.post(
    "/:id/banner",
    authAdmin,
    upload.single("file"),
    async (req, res) => {
        try {
            const businessId = (req.params.id ?? "").trim();
            const { business } = req.tokenData;

            if (!mongoose.Types.ObjectId.isValid(businessId))
                return res.status(400).json({ msg: "Invalid business id" });

            if (business && business !== businessId)
                return res.status(403).json({ msg: "Wrong business" });

            if (!req.file) return res.status(400).json({ msg: "No file uploaded" });

            const MAX = 50 * 1024 * 1024;
            if (req.file.size > MAX)
                return res.status(413).json({ msg: "File too large (50MB max)" });

            const folder = `toral/businesses/${businessId}/banner`;

            const isVideo = req.file.mimetype.startsWith("video/");
            const resourceType = isVideo ? "video" : "image";

            const result = isVideo
                ? await uploadLargeToCloudinary(req.file.buffer, folder, resourceType)
                : await uploadToCloudinary(req.file.buffer, folder, resourceType);

            const updated = await BusinessModel.findByIdAndUpdate(
                businessId,
                { banner: result.secure_url },
                { new: true }
            );

            res.json({
                msg: "Banner uploaded successfully",
                banner: result.secure_url,
                business: updated,
            });
        } catch (err) {
            console.error("upload banner error:", err);
            res.status(500).json({ msg: "Server error", error: err.message });
        }
    }
);

/* ======================================================
   🗑 DELETE BANNER
====================================================== */
router.delete("/:id/banner", authAdmin, async (req, res) => {
    try {
        const businessId = (req.params.id ?? "").trim();
        const { business } = req.tokenData;

        if (!mongoose.Types.ObjectId.isValid(businessId))
            return res.status(400).json({ msg: "Invalid business id" });

        if (business && business !== businessId)
            return res.status(403).json({ msg: "Wrong business" });

        const biz = await BusinessModel.findById(businessId);
        if (!biz) return res.status(404).json({ msg: "Business not found" });

        const url = biz.banner;
        if (url) {
            const publicId = getCloudinaryPublicId(url);
            const resourceType = guessResourceTypeFromUrl(url);

            if (publicId) {
                try {
                    await cloudinary.uploader.destroy(publicId, {
                        resource_type: resourceType,
                    });
                } catch (err) {
                    console.error("Cloudinary delete failed:", err);
                }
            }
        }

        biz.banner = "";
        await biz.save();

        res.json({ msg: "Banner deleted", business: biz });
    } catch (err) {
        console.error("DELETE /:id/banner error:", err);
        res.status(500).json({ msg: "Server error", error: err.message });
    }
});

/* ======================================================
   🎨 BANNER 2 (IMAGE ONLY)
====================================================== */
router.post(
    "/:id/banner2",
    authAdmin,
    upload.single("file"),
    async (req, res) => {
        try {
            const businessId = (req.params.id ?? "").trim();
            const { business } = req.tokenData;

            if (!mongoose.Types.ObjectId.isValid(businessId))
                return res.status(400).json({ msg: "Invalid business id" });

            if (business && business !== businessId)
                return res.status(403).json({ msg: "Wrong business" });

            if (!req.file) return res.status(400).json({ msg: "No file uploaded" });

            const folder = `toral/businesses/${businessId}/banner2`;

            const result = await uploadToCloudinary(
                req.file.buffer,
                folder,
                "image"
            );

            const biz = await BusinessModel.findById(businessId);
            if (!biz) return res.status(404).json({ msg: "Business not found" });

            // מחיקת באנר קודם אם קיים
            if (biz.banner2) {
                const publicId = getCloudinaryPublicId(biz.banner2);
                if (publicId) {
                    try {
                        await cloudinary.uploader.destroy(publicId, {
                            resource_type: "image",
                        });
                    } catch (err) {
                        console.error("Failed to delete old banner2:", err);
                    }
                }
            }

            biz.banner2 = result.secure_url;
            await biz.save();

            res.json({
                msg: "Banner2 uploaded successfully",
                banner2: biz.banner2,
                business: biz,
            });
        } catch (err) {
            console.error("upload banner2 error:", err);
            res.status(500).json({ msg: "Server error", error: err.message });
        }
    }
);

/* ======================================================
   🎨 BANNER 3 (IMAGE ONLY)
====================================================== */
router.post(
    "/:id/banner3",
    authAdmin,
    upload.single("file"),
    async (req, res) => {
        try {
            const businessId = (req.params.id ?? "").trim();
            const { business } = req.tokenData;

            if (!mongoose.Types.ObjectId.isValid(businessId))
                return res.status(400).json({ msg: "Invalid business id" });

            if (business && business !== businessId)
                return res.status(403).json({ msg: "Wrong business" });

            if (!req.file) return res.status(400).json({ msg: "No file uploaded" });

            const folder = `toral/businesses/${businessId}/banner3`;

            const result = await uploadToCloudinary(
                req.file.buffer,
                folder,
                "image"
            );

            const biz = await BusinessModel.findById(businessId);
            if (!biz) return res.status(404).json({ msg: "Business not found" });

            // מחיקת באנר קודם אם קיים
            if (biz.banner3) {
                const publicId = getCloudinaryPublicId(biz.banner3);
                if (publicId) {
                    try {
                        await cloudinary.uploader.destroy(publicId, {
                            resource_type: "image",
                        });
                    } catch (err) {
                        console.error("Failed to delete old banner3:", err);
                    }
                }
            }

            biz.banner3 = result.secure_url;
            await biz.save();

            res.json({
                msg: "Banner3 uploaded successfully",
                banner3: biz.banner3,
                business: biz,
            });
        } catch (err) {
            console.error("upload banner3 error:", err);
            res.status(500).json({ msg: "Server error", error: err.message });
        }
    }
);

/* ======================================================
   🖼 ADD PORTFOLIO IMAGE
====================================================== */
router.post(
    "/:id/portfolio",
    authAdmin,
    upload.single("file"),
    async (req, res) => {
        try {
            const businessId = (req.params.id ?? "").trim();
            const { business } = req.tokenData;

            if (!mongoose.Types.ObjectId.isValid(businessId))
                return res.status(400).json({ msg: "Invalid business id" });

            if (business && business !== businessId)
                return res.status(403).json({ msg: "Wrong business" });

            if (!req.file) return res.status(400).json({ msg: "No file uploaded" });

            const folder = `toral/businesses/${businessId}/portfolio`;

            const result = await uploadToCloudinary(
                req.file.buffer,
                folder,
                "image"
            );

            const updated = await BusinessModel.findByIdAndUpdate(
                businessId,
                { $push: { portfolio: result.secure_url } },
                { new: true }
            );

            res.json({
                msg: "Portfolio image uploaded",
                url: result.secure_url,
                business: updated,
            });
        } catch (err) {
            console.error("upload portfolio error:", err);
            res.status(500).json({ msg: "Server error", error: err.message });
        }
    }
);

/* ======================================================
   🗑 REMOVE PORTFOLIO IMAGE
====================================================== */
router.delete("/:id/portfolio", authAdmin, async (req, res) => {
    try {
        const businessId = (req.params.id ?? "").trim();
        const { business } = req.tokenData;
        const { imageUrl } = req.body;

        if (!mongoose.Types.ObjectId.isValid(businessId))
            return res.status(400).json({ msg: "Invalid business id" });

        if (business && business !== businessId)
            return res.status(403).json({ msg: "Wrong business" });

        if (!imageUrl || typeof imageUrl !== "string") {
            return res.status(400).json({ msg: "imageUrl is required" });
        }

        const publicId = getCloudinaryPublicId(imageUrl);
        if (publicId) {
            try {
                await cloudinary.uploader.destroy(publicId, {
                    resource_type: "image",
                });
            } catch (err) {
                console.error("Failed to delete image:", err);
            }
        }

        const updated = await BusinessModel.findByIdAndUpdate(
            businessId,
            { $pull: { portfolio: imageUrl } },
            { new: true }
        );

        res.json({ msg: "Image deleted", business: updated });
    } catch (err) {
        console.error("DELETE /:id/portfolio error:", err);
        res.status(500).json({ msg: "Server error", error: err.message });
    }
});

/* ======================================================
   👤 SET OWNER
====================================================== */
router.patch("/:id/set-owner", authAdmin, async (req, res) => {
    try {
        const businessId = (req.params.id ?? "").trim();
        const { ownerId } = req.body;

        if (!mongoose.Types.ObjectId.isValid(businessId))
            return res.status(400).json({ msg: "Invalid business id" });

        if (!mongoose.Types.ObjectId.isValid(ownerId))
            return res.status(400).json({ msg: "Invalid owner id" });

        const updated = await BusinessModel.findOneAndUpdate(
            { _id: businessId },
            { owner: ownerId },
            { new: true }
        )
            .populate("owner", "_id name phone avatarUrl")
            .populate("workers", "_id name phone avatarUrl");

        res.json(updated);
    } catch (err) {
        console.error("PATCH /:id/set-owner error:", err);
        res.status(500).json({ msg: "Server error", error: err.message });
    }
});

/* ======================================================
   🎨 UPDATE BUSINESS COLORS
====================================================== */
router.patch("/colors", authAdmin, async (req, res) => {
    try {
        const { business } = req.tokenData;
        const { error, value } = colorsPresetSchema.validate(req.body);

        if (error) {
            return res.status(400).json({ msg: "Invalid preset" });
        }

        const preset = value.preset;
        const colors = COLOR_PRESETS[preset];

        const updated = await BusinessModel.findByIdAndUpdate(
            business,
            { business_colors: colors },
            { new: true }
        );

        res.json({ msg: "Colors updated", business: updated });
    } catch (err) {
        console.error("PATCH /colors error:", err);
        res.status(500).json({ msg: "Server error" });
    }
});

/* ======================================================
   📝 UPDATE MESSAGE (POPUP TEXT)
====================================================== */
router.patch("/:id/message", authAdmin, async (req, res) => {
    try {
        const businessId = (req.params.id ?? "").trim();
        const { business } = req.tokenData;

        if (!mongoose.Types.ObjectId.isValid(businessId))
            return res.status(400).json({ msg: "Invalid business id" });

        if (business && business !== businessId)
            return res.status(403).json({ msg: "Wrong business" });

        const { error, value } = messageSchema.validate(req.body);
        if (error) {
            return res.status(400).json({ msg: "Invalid message", details: error.details });
        }

        const updated = await BusinessModel.findByIdAndUpdate(
            businessId,
            { message: value.message },
            { new: true }
        );

        if (!updated) return res.status(404).json({ msg: "Business not found" });

        res.json({ msg: "Message updated", business: updated });
    } catch (err) {
        console.error("PATCH /:id/message error:", err);
        res.status(500).json({ msg: "Server error", error: err.message });
    }
});

/* ======================================================
   📝 UPDATE ABOUT US
====================================================== */
router.patch("/:id/about", authAdmin, async (req, res) => {
    try {
        const businessId = (req.params.id ?? "").trim();
        const { business } = req.tokenData;

        if (!mongoose.Types.ObjectId.isValid(businessId))
            return res.status(400).json({ msg: "Invalid business id" });

        if (business && business !== businessId)
            return res.status(403).json({ msg: "Wrong business" });

        const { error, value } = aboutUsSchema.validate(req.body);
        if (error) {
            return res.status(400).json({ msg: "Invalid aboutUs", details: error.details });
        }

        const updated = await BusinessModel.findByIdAndUpdate(
            businessId,
            { aboutUs: value.aboutUs },
            { new: true }
        );

        if (!updated) return res.status(404).json({ msg: "Business not found" });

        res.json({ msg: "AboutUs updated", business: updated });
    } catch (err) {
        console.error("PATCH /:id/about error:", err);
        res.status(500).json({ msg: "Server error", error: err.message });
    }
});

/* ======================================================
   📝 UPDATE ADDRESS
====================================================== */
router.patch("/:id/address", authAdmin, async (req, res) => {
    try {
        const businessId = (req.params.id ?? "").trim();
        const { business } = req.tokenData;

        if (!mongoose.Types.ObjectId.isValid(businessId))
            return res.status(400).json({ msg: "Invalid business id" });

        if (business && business !== businessId)
            return res.status(403).json({ msg: "Wrong business" });

        const { error, value } = addressSchema.validate(req.body);
        if (error) {
            return res.status(400).json({ msg: "Invalid address", details: error.details });
        }

        const updated = await BusinessModel.findByIdAndUpdate(
            businessId,
            { address: value.address },
            { new: true }
        );

        if (!updated) return res.status(404).json({ msg: "Business not found" });

        res.json({ msg: "Address updated", business: updated });
    } catch (err) {
        console.error("PATCH /:id/address error:", err);
        res.status(500).json({ msg: "Server error", error: err.message });
    }
});

/* ======================================================
   🕒 UPDATE OPENING HOURS
====================================================== */
router.patch("/:id/opening-hours", authAdmin, async (req, res) => {
    try {
        const businessId = (req.params.id ?? "").trim();
        const { business } = req.tokenData;

        if (!mongoose.Types.ObjectId.isValid(businessId))
            return res.status(400).json({ msg: "Invalid business id" });

        if (business && business !== businessId)
            return res.status(403).json({ msg: "Wrong business" });

        const { error, value } = openingHoursSchema.validate(req.body);
        if (error) {
            return res
                .status(400)
                .json({ msg: "Invalid openingHours", details: error.details });
        }

        const updated = await BusinessModel.findByIdAndUpdate(
            businessId,
            { openingHours: value.openingHours },
            { new: true }
        );

        if (!updated) return res.status(404).json({ msg: "Business not found" });

        res.json({ msg: "OpeningHours updated", business: updated });
    } catch (err) {
        console.error("PATCH /:id/opening-hours error:", err);
        res.status(500).json({ msg: "Server error", error: err.message });
    }
});

/* ======================================================
   💈 SERVICES CRUD (ADD / UPDATE / DELETE)
====================================================== */

/**
 * POST /businesses/:id/services
 * יצירת שירות חדש לעסק
 */
router.post("/:id/services", authAdmin, async (req, res) => {
    try {
        const businessId = (req.params.id ?? "").trim();
        const { business } = req.tokenData;

        if (!mongoose.Types.ObjectId.isValid(businessId)) {
            return res.status(400).json({ msg: "Invalid business id" });
        }

        if (business && business !== businessId) {
            return res.status(403).json({ msg: "Wrong business" });
        }

        const { error, value } = serviceBodySchema.validate(req.body);
        if (error) {
            return res
                .status(400)
                .json({ msg: "Invalid service", details: error.details });
        }

        const biz = await BusinessModel.findById(businessId);
        if (!biz) return res.status(404).json({ msg: "Business not found" });

        // מוסיפים שירות חדש – ObjectId אוטומטי
        biz.services.push({
            name: value.name,
            duration: value.duration,
            price: value.price,
        });

        await biz.save();

        const newService = biz.services[biz.services.length - 1];

        res.json({ msg: "Service added", business: biz, service: newService });
    } catch (err) {
        console.error("POST /:id/services error:", err);
        res.status(500).json({ msg: "Server error", error: err.message });
    }
});

/**
 * PATCH /businesses/:id/services/:serviceId
 * עדכון שירות קיים
 */
router.patch("/:id/services/:serviceId", authAdmin, async (req, res) => {
    try {
        const businessId = (req.params.id ?? "").trim();
        const serviceId = (req.params.serviceId ?? "").trim();
        const { business } = req.tokenData;

        if (!mongoose.Types.ObjectId.isValid(businessId)) {
            return res.status(400).json({ msg: "Invalid business id" });
        }

        if (business && business !== businessId) {
            return res.status(403).json({ msg: "Wrong business" });
        }

        const { error, value } = serviceUpdateSchema.validate(req.body);
        if (error) {
            return res
                .status(400)
                .json({ msg: "Invalid service update", details: error.details });
        }

        const biz = await BusinessModel.findById(businessId);
        if (!biz) return res.status(404).json({ msg: "Business not found" });

        // מציאת סאב־דוקומנט לפי ObjectId
        const service = biz.services.id(serviceId);
        if (!service) {
            return res.status(404).json({ msg: "Service not found" });
        }

        if (value.name !== undefined) service.name = value.name;
        if (value.duration !== undefined) service.duration = value.duration;
        if (value.price !== undefined) service.price = value.price;

        await biz.save();

        res.json({ msg: "Service updated", business: biz, service });
    } catch (err) {
        console.error("PATCH /:id/services/:serviceId error:", err);
        res.status(500).json({ msg: "Server error", error: err.message });
    }
});

/**
 * DELETE /businesses/:id/services/:serviceId
 * מחיקת שירות
 */
router.delete("/:id/services/:serviceId", authAdmin, async (req, res) => {
    try {
        const businessId = (req.params.id ?? "").trim();
        const serviceId = (req.params.serviceId ?? "").trim();
        const { business } = req.tokenData;

        if (!mongoose.Types.ObjectId.isValid(businessId)) {
            return res.status(400).json({ msg: "Invalid business id" });
        }

        if (business && business !== businessId) {
            return res.status(403).json({ msg: "Wrong business" });
        }

        const biz = await BusinessModel.findById(businessId);
        if (!biz) return res.status(404).json({ msg: "Business not found" });

        const service = biz.services.id(serviceId);
        if (!service) {
            return res.status(404).json({ msg: "Service not found" });
        }

        service.deleteOne();
        await biz.save();

        res.json({ msg: "Service deleted", business: biz });
    } catch (err) {
        console.error("DELETE /:id/services/:serviceId error:", err);
        res.status(500).json({ msg: "Server error", error: err.message });
    }
});

/* ======================================================
   HELPER: Phone Normalization (כמו באפליקציה)
====================================================== */
const normalizePhone = (phone) => {
    if (!phone) return "";
    const p = phone.trim();
    // אם מתחיל ב-0, נחליף ב-+972
    if (p.startsWith("0")) {
        return p.replace(/^0/, "+972");
    }
    return p;
};

/* ======================================================
   👷 ADD WORKER (Auto Upgrade to Admin)
====================================================== */
router.post("/:id/workers", authAdmin, async (req, res) => {
    try {
        const businessId = (req.params.id ?? "").trim();
        const { phone } = req.body;
        const { business } = req.tokenData;

        if (!mongoose.Types.ObjectId.isValid(businessId))
            return res.status(400).json({ msg: "Invalid business id" });

        if (business && business !== businessId)
            return res.status(403).json({ msg: "Wrong business" });

        if (!phone) return res.status(400).json({ msg: "Phone is required" });

        // נרמול טלפון
        const normalizedPhone = normalizePhone(phone);

        const UserModel = mongoose.model("users");
        const userToAdd = await UserModel.findOne({ phone: normalizedPhone });

        if (!userToAdd) {
            return res.status(404).json({ msg: "לא נמצא משתמש עם הטלפון הזה" });
        }

        // 🔥🔥🔥 שדרוג אוטומטי לאדמין 🔥🔥🔥
        // אם המשתמש הוא עדיין 'user' רגיל, נהפוך אותו ל-'admin' כי הוא הופך לעובד
        if (userToAdd.role !== "admin") {
            userToAdd.role = "admin";
            await userToAdd.save();
            console.log(`User ${userToAdd._id} auto-upgraded to admin upon being added as worker.`);
        }

        const biz = await BusinessModel.findById(businessId);
        if (!biz) return res.status(404).json({ msg: "Business not found" });

        // בדיקה שהוא לא הבעלים
        if (biz.owner.toString() === userToAdd._id.toString()) {
            return res.status(400).json({ msg: "המשתמש הוא כבר הבעלים של העסק" });
        }

        // בדיקה שהוא לא כבר עובד
        const isAlreadyWorker = biz.workers.some(
            (wId) => wId.toString() === userToAdd._id.toString()
        );

        if (isAlreadyWorker) {
            return res.status(400).json({ msg: "המשתמש כבר קיים ברשימת העובדים" });
        }

        // הוספה לרשימת העובדים
        biz.workers.push(userToAdd._id);
        await biz.save();

        const updated = await BusinessModel.findById(businessId)
            .populate("workers", "_id name phone avatarUrl")
            .populate("owner", "_id name phone avatarUrl");

        res.json({ msg: "העובד נוסף בהצלחה (ושודרג לאדמין)", business: updated });

    } catch (err) {
        console.error("POST /:id/workers error:", err);
        res.status(500).json({ msg: "Server error", error: err.message });
    }
});
/* ======================================================
   🗑 REMOVE WORKER
====================================================== */
router.delete("/:id/workers/:workerId", authAdmin, async (req, res) => {
    try {
        const businessId = (req.params.id ?? "").trim();
        const workerId = (req.params.workerId ?? "").trim();
        const { business } = req.tokenData;

        if (!mongoose.Types.ObjectId.isValid(businessId))
            return res.status(400).json({ msg: "Invalid business id" });

        if (business && business !== businessId)
            return res.status(403).json({ msg: "Wrong business" });

        const updated = await BusinessModel.findByIdAndUpdate(
            businessId,
            { $pull: { workers: workerId } },
            { new: true }
        )
            .populate("workers", "_id name phone avatarUrl")
            .populate("owner", "_id name phone avatarUrl");

        if (!updated) return res.status(404).json({ msg: "Business not found" });

        res.json({ msg: "Worker removed", business: updated });
    } catch (err) {
        console.error("DELETE /:id/workers error:", err);
        res.status(500).json({ msg: "Server error", error: err.message });
    }
});

module.exports = router;
