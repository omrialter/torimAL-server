const express = require("express");
const mongoose = require("mongoose");
const Joi = require("joi");
const cloudinary = require("cloudinary").v2;
const streamifier = require("streamifier");
const multer = require("multer");

// Internal Imports
const { BusinessModel, validateBusiness } = require("../models/businessModel.js");
const { UserModel } = require("../models/userModel");
const { AppointmentModel } = require("../models/appointmentModel");
const { auth, authAdmin } = require("../auth/auth.js");

const router = express.Router();

/* ======================================================
   🌥 CLOUDINARY & MULTER CONFIG
====================================================== */

cloudinary.config({
    cloud_name: process.env.CLOUD_NAME,
    api_key: process.env.CLOUD_KEY,
    api_secret: process.env.CLOUD_SECRET,
    timeout: 600000, // Allow large/slow uploads (video)
});

// Multer: Limit to 50MB (Memory Storage)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 },
});

/* ======================================================
   🛠 HELPERS
====================================================== */

// Upload Image/Small File
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

// Upload Large File (Video) - Chunked
function uploadLargeToCloudinary(buffer, folder, resourceType = "video") {
    return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
            {
                resource_type: resourceType,
                folder,
                chunk_size: 6_000_000, // 6MB Chunks
            },
            (error, result) => {
                if (error) return reject(error);
                resolve(result);
            }
        );
        streamifier.createReadStream(buffer).pipe(uploadStream);
    });
}

// Extract Public ID from Cloudinary URL (for deletion)
function getCloudinaryPublicId(url) {
    try {
        const u = new URL(url);
        const parts = u.pathname.split("/").filter(Boolean);
        const uploadIndex = parts.indexOf("upload");
        if (uploadIndex === -1) return null;

        let publicIdParts = parts.slice(uploadIndex + 1);

        // Remove version (e.g., v12345678)
        if (publicIdParts[0]?.startsWith("v") && /^\d+$/.test(publicIdParts[0].slice(1))) {
            publicIdParts = publicIdParts.slice(1);
        }

        const joined = publicIdParts.join("/");
        const dot = joined.lastIndexOf(".");
        return dot === -1 ? joined : joined.substring(0, dot);
    } catch {
        return null;
    }
}

// Guess resource type for cleanup
function guessResourceTypeFromUrl(url) {
    const ext = url.split(".").pop()?.toLowerCase();
    const VIDEO_EXTS = ["mp4", "mov", "webm", "avi", "mkv"];
    return VIDEO_EXTS.includes(ext) ? "video" : "image";
}

// Phone Normalizer (IL specific)
const normalizePhone = (phone) => {
    if (!phone) return "";
    const p = phone.trim();
    if (p.startsWith("0")) {
        return p.replace(/^0/, "+972");
    }
    return p;
};

// Check if string is valid ObjectId
const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

/* ======================================================
   🎨 COLOR PRESETS & VALIDATION SCHEMAS
====================================================== */

const COLOR_PRESETS = {
    professional: { primary: "#1d4ed8", secondary: "#f3f4f6", third: "#0b1120" },
    midnight: { primary: "#0ea5e9", secondary: "#0f172a", third: "#f8fafc" },
    forest: { primary: "#065f46", secondary: "#e6f4f1", third: "#0b2722" },
    sunset: { primary: "#ea580c", secondary: "#fff7ed", third: "#7c2d12" },
    royal: { primary: "#7c3aed", secondary: "#f3e8ff", third: "#2e1065" },
};

const colorsPresetSchema = Joi.object({
    preset: Joi.string().valid(...Object.keys(COLOR_PRESETS)).required(),
});

const messageSchema = Joi.object({ message: Joi.string().max(4000).allow("").required() });
const aboutUsSchema = Joi.object({ aboutUs: Joi.string().max(8000).allow("").required() });
const addressSchema = Joi.object({ address: Joi.string().max(300).allow("").required() });

const timeRangeSchema = Joi.object({
    open: Joi.string().allow(null).pattern(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/).allow(""),
    close: Joi.string().allow(null).pattern(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/).allow(""),
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
   🟢 ROUTES
====================================================== */

// Health Check
router.get("/", async (req, res) => {
    res.json({ msg: "Businesses service operational" });
});

/* 📌 GET BUSINESS INFO */
router.get("/businessInfo/:id", auth, async (req, res) => {
    const id = (req.params.id ?? "").trim();
    const { business } = req.tokenData;

    if (!isValidObjectId(id)) return res.status(400).json({ error: "Invalid business id" });

    // Security: Check if token matches requested business
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

/* 📊 GET BUSINESS STATISTICS */
router.get("/:id/stats", authAdmin, async (req, res) => {
    try {
        const businessId = (req.params.id ?? "").trim();
        const { business } = req.tokenData;

        if (!isValidObjectId(businessId)) return res.status(400).json({ error: "Invalid id" });
        if (business && business !== businessId) return res.status(403).json({ error: "Access denied" });

        const now = new Date();
        const startOfCurrentMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const threeMonthsAgo = new Date();
        threeMonthsAgo.setMonth(now.getMonth() - 3);

        const [
            totalClients,
            completedThisMonth,
            noShowThisMonth,
            completedLastMonth,
            noShowLastMonth,
            activeUsersLast3Months,
        ] = await Promise.all([
            // 1. Total Clients
            UserModel.countDocuments({ business: businessId, role: "user" }),

            // 2. Completed This Month
            AppointmentModel.countDocuments({
                business: businessId,
                status: "completed",
                start: { $gte: startOfCurrentMonth },
            }),

            // 3. No-Show This Month
            AppointmentModel.countDocuments({
                business: businessId,
                status: "no_show",
                start: { $gte: startOfCurrentMonth },
            }),

            // 4. Completed Last Month
            AppointmentModel.countDocuments({
                business: businessId,
                status: "completed",
                start: { $gte: startOfLastMonth, $lt: startOfCurrentMonth },
            }),

            // 5. No-Show Last Month
            AppointmentModel.countDocuments({
                business: businessId,
                status: "no_show",
                start: { $gte: startOfLastMonth, $lt: startOfCurrentMonth },
            }),

            // 6. Active Users (Last 3 Months)
            AppointmentModel.distinct("client", {
                business: businessId,
                start: { $gte: threeMonthsAgo },
                status: { $ne: "canceled" },
            }),
        ]);

        const activeCount = activeUsersLast3Months.length;
        const inactiveUsers = Math.max(0, totalClients - activeCount);

        res.json({
            totalClients,
            completedThisMonth,
            noShowThisMonth,
            completedLastMonth,
            noShowLastMonth,
            inactiveUsers,
        });
    } catch (err) {
        console.error("GET /:id/stats error:", err);
        res.status(500).json({ error: "Server error" });
    }
});

/* 🟩 POST NEW BUSINESS (Initial Setup / Admin) */
// הורדנו את authAdmin והוספנו בדיקת סיסמה ידנית
router.post("/", async (req, res) => {

    // 1. בדיקת אבטחה: האם נשלח המפתח הסודי?
    // משתמשים ב-JWT_SECRET שיש לך ב-.env בתור סיסמה זמנית
    if (req.headers["x-admin-key"] !== process.env.JWT_SECRET) {
        return res.status(401).json({ msg: "Not authorized: Missing or wrong x-admin-key" });
    }

    // 2. ולידציה (עכשיו Joi מאפשר owner ריק כי תיקנו קודם)
    const valid = validateBusiness(req.body);
    if (valid.error) return res.status(400).json(valid.error.details);

    try {
        const business = new BusinessModel(req.body);
        await business.save();

        // מחזירים את העסק שנוצר (כולל ה-_id שלו)
        res.status(201).json(business);
    } catch (err) {
        console.error("POST /business error:", err);
        if (err.code === 11000) {
            res.status(400).json({ msg: "Business already exists", code: 11000 });
        } else {
            res.status(500).json({ msg: "Server error", error: err.message });
        }
    }
});

/* 🌆 UPLOAD BANNER (Image/Video) */
router.post("/:id/banner", authAdmin, upload.single("file"), async (req, res) => {
    try {
        const businessId = (req.params.id ?? "").trim();
        const { business } = req.tokenData;

        if (!isValidObjectId(businessId)) return res.status(400).json({ msg: "Invalid id" });
        if (business && business !== businessId) return res.status(403).json({ msg: "Access denied" });
        if (!req.file) return res.status(400).json({ msg: "No file uploaded" });

        const MAX = 50 * 1024 * 1024;
        if (req.file.size > MAX) return res.status(413).json({ msg: "File too large (50MB max)" });

        const folder = `torimal/businesses/${businessId}/banner`;
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
});

/* 🗑 DELETE BANNER */
router.delete("/:id/banner", authAdmin, async (req, res) => {
    try {
        const businessId = (req.params.id ?? "").trim();
        const { business } = req.tokenData;

        if (!isValidObjectId(businessId)) return res.status(400).json({ msg: "Invalid id" });
        if (business && business !== businessId) return res.status(403).json({ msg: "Access denied" });

        const biz = await BusinessModel.findById(businessId);
        if (!biz) return res.status(404).json({ msg: "Business not found" });

        if (biz.banner) {
            const publicId = getCloudinaryPublicId(biz.banner);
            const resourceType = guessResourceTypeFromUrl(biz.banner);
            if (publicId) {
                try {
                    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
                } catch (e) {
                    console.error("Cloudinary delete failed:", e);
                }
            }
        }

        biz.banner = "";
        await biz.save();
        res.json({ msg: "Banner deleted", business: biz });
    } catch (err) {
        console.error("DELETE /banner error:", err);
        res.status(500).json({ msg: "Server error", error: err.message });
    }
});

/* 🎨 UPLOAD BANNER 2 (Image Only) */
router.post("/:id/banner2", authAdmin, upload.single("file"), async (req, res) => {
    try {
        const businessId = (req.params.id ?? "").trim();
        const { business } = req.tokenData;

        if (!isValidObjectId(businessId)) return res.status(400).json({ msg: "Invalid id" });
        if (business && business !== businessId) return res.status(403).json({ msg: "Access denied" });
        if (!req.file) return res.status(400).json({ msg: "No file uploaded" });

        const folder = `toral/businesses/${businessId}/banner2`;
        const result = await uploadToCloudinary(req.file.buffer, folder, "image");

        const biz = await BusinessModel.findById(businessId);
        if (!biz) return res.status(404).json({ msg: "Business not found" });

        // Cleanup old banner
        if (biz.banner2) {
            const publicId = getCloudinaryPublicId(biz.banner2);
            if (publicId) {
                try {
                    await cloudinary.uploader.destroy(publicId, { resource_type: "image" });
                } catch (e) { console.error("Failed to delete old banner2:", e); }
            }
        }

        biz.banner2 = result.secure_url;
        await biz.save();

        res.json({ msg: "Banner2 uploaded", banner2: biz.banner2, business: biz });
    } catch (err) {
        console.error("upload banner2 error:", err);
        res.status(500).json({ msg: "Server error", error: err.message });
    }
});

/* 🎨 UPLOAD BANNER 3 (Image Only) */
router.post("/:id/banner3", authAdmin, upload.single("file"), async (req, res) => {
    try {
        const businessId = (req.params.id ?? "").trim();
        const { business } = req.tokenData;

        if (!isValidObjectId(businessId)) return res.status(400).json({ msg: "Invalid id" });
        if (business && business !== businessId) return res.status(403).json({ msg: "Access denied" });
        if (!req.file) return res.status(400).json({ msg: "No file uploaded" });

        const folder = `torimal/businesses/${businessId}/banner3`;
        const result = await uploadToCloudinary(req.file.buffer, folder, "image");

        const biz = await BusinessModel.findById(businessId);
        if (!biz) return res.status(404).json({ msg: "Business not found" });

        if (biz.banner3) {
            const publicId = getCloudinaryPublicId(biz.banner3);
            if (publicId) {
                try {
                    await cloudinary.uploader.destroy(publicId, { resource_type: "image" });
                } catch (e) { console.error("Failed to delete old banner3:", e); }
            }
        }

        biz.banner3 = result.secure_url;
        await biz.save();

        res.json({ msg: "Banner3 uploaded", banner3: biz.banner3, business: biz });
    } catch (err) {
        console.error("upload banner3 error:", err);
        res.status(500).json({ msg: "Server error", error: err.message });
    }
});

/* 🖼 ADD PORTFOLIO IMAGE */
router.post("/:id/portfolio", authAdmin, upload.single("file"), async (req, res) => {
    try {
        const businessId = (req.params.id ?? "").trim();
        const { business } = req.tokenData;

        if (!isValidObjectId(businessId)) return res.status(400).json({ msg: "Invalid id" });
        if (business && business !== businessId) return res.status(403).json({ msg: "Access denied" });
        if (!req.file) return res.status(400).json({ msg: "No file uploaded" });

        const folder = `torimal/businesses/${businessId}/portfolio`;
        const result = await uploadToCloudinary(req.file.buffer, folder, "image");

        const updated = await BusinessModel.findByIdAndUpdate(
            businessId,
            { $push: { portfolio: result.secure_url } },
            { new: true }
        );

        res.json({ msg: "Portfolio image added", url: result.secure_url, business: updated });
    } catch (err) {
        console.error("upload portfolio error:", err);
        res.status(500).json({ msg: "Server error", error: err.message });
    }
});

/* 🗑 REMOVE PORTFOLIO IMAGE */
router.delete("/:id/portfolio", authAdmin, async (req, res) => {
    try {
        const businessId = (req.params.id ?? "").trim();
        const { business } = req.tokenData;
        const { imageUrl } = req.body;

        if (!isValidObjectId(businessId)) return res.status(400).json({ msg: "Invalid id" });
        if (business && business !== businessId) return res.status(403).json({ msg: "Access denied" });
        if (!imageUrl || typeof imageUrl !== "string") return res.status(400).json({ msg: "imageUrl required" });

        const publicId = getCloudinaryPublicId(imageUrl);
        if (publicId) {
            try {
                await cloudinary.uploader.destroy(publicId, { resource_type: "image" });
            } catch (e) { console.error("Delete image failed:", e); }
        }

        const updated = await BusinessModel.findByIdAndUpdate(
            businessId,
            { $pull: { portfolio: imageUrl } },
            { new: true }
        );

        res.json({ msg: "Image deleted", business: updated });
    } catch (err) {
        console.error("DELETE portfolio error:", err);
        res.status(500).json({ msg: "Server error", error: err.message });
    }
});

/* 👤 SET OWNER */
router.patch("/:id/set-owner", authAdmin, async (req, res) => {
    try {
        const businessId = (req.params.id ?? "").trim();
        const { ownerId } = req.body;

        if (!isValidObjectId(businessId)) return res.status(400).json({ msg: "Invalid business id" });
        if (!isValidObjectId(ownerId)) return res.status(400).json({ msg: "Invalid owner id" });

        const updated = await BusinessModel.findOneAndUpdate(
            { _id: businessId },
            { owner: ownerId },
            { new: true }
        )
            .populate("owner", "_id name phone avatarUrl")
            .populate("workers", "_id name phone avatarUrl");

        res.json(updated);
    } catch (err) {
        console.error("PATCH /set-owner error:", err);
        res.status(500).json({ msg: "Server error", error: err.message });
    }
});

/* 🎨 UPDATE BUSINESS COLORS */
router.patch("/colors", authAdmin, async (req, res) => {
    try {
        const { business } = req.tokenData;
        const { error, value } = colorsPresetSchema.validate(req.body);

        if (error) return res.status(400).json({ msg: "Invalid preset" });

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

/* 📝 UPDATE INFO (Message, About, Address, OpeningHours) */
// Grouping similar update logic is also an option, but keeping separate routes is fine for clarity.

router.patch("/:id/message", authAdmin, async (req, res) => {
    try {
        const businessId = (req.params.id ?? "").trim();
        const { business } = req.tokenData;

        if (!isValidObjectId(businessId)) return res.status(400).json({ msg: "Invalid id" });
        if (business && business !== businessId) return res.status(403).json({ msg: "Access denied" });

        const { error, value } = messageSchema.validate(req.body);
        if (error) return res.status(400).json({ msg: "Invalid message", details: error.details });

        const updated = await BusinessModel.findByIdAndUpdate(
            businessId,
            { message: value.message },
            { new: true }
        );
        if (!updated) return res.status(404).json({ msg: "Business not found" });

        res.json({ msg: "Message updated", business: updated });
    } catch (err) {
        console.error("PATCH /message error:", err);
        res.status(500).json({ msg: "Server error", error: err.message });
    }
});

router.patch("/:id/about", authAdmin, async (req, res) => {
    try {
        const businessId = (req.params.id ?? "").trim();
        const { business } = req.tokenData;

        if (!isValidObjectId(businessId)) return res.status(400).json({ msg: "Invalid id" });
        if (business && business !== businessId) return res.status(403).json({ msg: "Access denied" });

        const { error, value } = aboutUsSchema.validate(req.body);
        if (error) return res.status(400).json({ msg: "Invalid aboutUs", details: error.details });

        const updated = await BusinessModel.findByIdAndUpdate(
            businessId,
            { aboutUs: value.aboutUs },
            { new: true }
        );
        if (!updated) return res.status(404).json({ msg: "Business not found" });

        res.json({ msg: "AboutUs updated", business: updated });
    } catch (err) {
        console.error("PATCH /about error:", err);
        res.status(500).json({ msg: "Server error", error: err.message });
    }
});

router.patch("/:id/address", authAdmin, async (req, res) => {
    try {
        const businessId = (req.params.id ?? "").trim();
        const { business } = req.tokenData;

        if (!isValidObjectId(businessId)) return res.status(400).json({ msg: "Invalid id" });
        if (business && business !== businessId) return res.status(403).json({ msg: "Access denied" });

        const { error, value } = addressSchema.validate(req.body);
        if (error) return res.status(400).json({ msg: "Invalid address", details: error.details });

        const updated = await BusinessModel.findByIdAndUpdate(
            businessId,
            { address: value.address },
            { new: true }
        );
        if (!updated) return res.status(404).json({ msg: "Business not found" });

        res.json({ msg: "Address updated", business: updated });
    } catch (err) {
        console.error("PATCH /address error:", err);
        res.status(500).json({ msg: "Server error", error: err.message });
    }
});

router.patch("/:id/opening-hours", authAdmin, async (req, res) => {
    try {
        const businessId = (req.params.id ?? "").trim();
        const { business } = req.tokenData;

        if (!isValidObjectId(businessId)) return res.status(400).json({ msg: "Invalid id" });
        if (business && business !== businessId) return res.status(403).json({ msg: "Access denied" });

        const { error, value } = openingHoursSchema.validate(req.body);
        if (error) return res.status(400).json({ msg: "Invalid openingHours", details: error.details });

        const updated = await BusinessModel.findByIdAndUpdate(
            businessId,
            { openingHours: value.openingHours },
            { new: true }
        );
        if (!updated) return res.status(404).json({ msg: "Business not found" });

        res.json({ msg: "OpeningHours updated", business: updated });
    } catch (err) {
        console.error("PATCH /opening-hours error:", err);
        res.status(500).json({ msg: "Server error", error: err.message });
    }
});

/* ======================================================
   💈 SERVICES CRUD
====================================================== */

router.post("/:id/services", authAdmin, async (req, res) => {
    try {
        const businessId = (req.params.id ?? "").trim();
        const { business } = req.tokenData;

        if (!isValidObjectId(businessId)) return res.status(400).json({ msg: "Invalid id" });
        if (business && business !== businessId) return res.status(403).json({ msg: "Access denied" });

        const { error, value } = serviceBodySchema.validate(req.body);
        if (error) return res.status(400).json({ msg: "Invalid service", details: error.details });

        const biz = await BusinessModel.findById(businessId);
        if (!biz) return res.status(404).json({ msg: "Business not found" });

        // Push new service (ObjectId auto-generated)
        biz.services.push({
            name: value.name,
            duration: value.duration,
            price: value.price,
        });
        await biz.save();

        const newService = biz.services[biz.services.length - 1];
        res.json({ msg: "Service added", business: biz, service: newService });
    } catch (err) {
        console.error("POST /services error:", err);
        res.status(500).json({ msg: "Server error", error: err.message });
    }
});

router.patch("/:id/services/:serviceId", authAdmin, async (req, res) => {
    try {
        const businessId = (req.params.id ?? "").trim();
        const serviceId = (req.params.serviceId ?? "").trim();
        const { business } = req.tokenData;

        if (!isValidObjectId(businessId)) return res.status(400).json({ msg: "Invalid business id" });
        if (business && business !== businessId) return res.status(403).json({ msg: "Access denied" });

        const { error, value } = serviceUpdateSchema.validate(req.body);
        if (error) return res.status(400).json({ msg: "Invalid update", details: error.details });

        const biz = await BusinessModel.findById(businessId);
        if (!biz) return res.status(404).json({ msg: "Business not found" });

        const service = biz.services.id(serviceId);
        if (!service) return res.status(404).json({ msg: "Service not found" });

        if (value.name !== undefined) service.name = value.name;
        if (value.duration !== undefined) service.duration = value.duration;
        if (value.price !== undefined) service.price = value.price;

        await biz.save();
        res.json({ msg: "Service updated", business: biz, service });
    } catch (err) {
        console.error("PATCH /services error:", err);
        res.status(500).json({ msg: "Server error", error: err.message });
    }
});

router.delete("/:id/services/:serviceId", authAdmin, async (req, res) => {
    try {
        const businessId = (req.params.id ?? "").trim();
        const serviceId = (req.params.serviceId ?? "").trim();
        const { business } = req.tokenData;

        if (!isValidObjectId(businessId)) return res.status(400).json({ msg: "Invalid business id" });
        if (business && business !== businessId) return res.status(403).json({ msg: "Access denied" });

        const biz = await BusinessModel.findById(businessId);
        if (!biz) return res.status(404).json({ msg: "Business not found" });

        const service = biz.services.id(serviceId);
        if (!service) return res.status(404).json({ msg: "Service not found" });

        service.deleteOne();
        await biz.save();

        res.json({ msg: "Service deleted", business: biz });
    } catch (err) {
        console.error("DELETE /services error:", err);
        res.status(500).json({ msg: "Server error", error: err.message });
    }
});

/* ======================================================
   👷 WORKERS MANAGEMENT (Add & Upgrade to Admin)
====================================================== */

router.post("/:id/workers", authAdmin, async (req, res) => {
    try {
        const businessId = (req.params.id ?? "").trim();
        const { phone } = req.body;
        const { business } = req.tokenData;

        if (!isValidObjectId(businessId)) return res.status(400).json({ msg: "Invalid id" });
        if (business && business !== businessId) return res.status(403).json({ msg: "Access denied" });
        if (!phone) return res.status(400).json({ msg: "Phone is required" });

        const normalizedPhone = normalizePhone(phone);
        const UserModel = mongoose.model("users");
        const userToAdd = await UserModel.findOne({ phone: normalizedPhone });

        if (!userToAdd) {
            return res.status(404).json({ msg: "User not found with this phone" });
        }

        // 🔥 Auto-Upgrade: Users becoming workers must be admins to access admin panel
        if (userToAdd.role !== "admin") {
            userToAdd.role = "admin";
            await userToAdd.save();
        }

        const biz = await BusinessModel.findById(businessId);
        if (!biz) return res.status(404).json({ msg: "Business not found" });

        if (biz.owner.toString() === userToAdd._id.toString()) {
            return res.status(400).json({ msg: "User is already the owner" });
        }

        const isAlreadyWorker = biz.workers.some(
            (wId) => wId.toString() === userToAdd._id.toString()
        );
        if (isAlreadyWorker) {
            return res.status(400).json({ msg: "User is already a worker" });
        }

        biz.workers.push(userToAdd._id);
        await biz.save();

        const updated = await BusinessModel.findById(businessId)
            .populate("workers", "_id name phone avatarUrl")
            .populate("owner", "_id name phone avatarUrl");

        res.json({ msg: "Worker added (and upgraded to admin)", business: updated });

    } catch (err) {
        console.error("POST /workers error:", err);
        res.status(500).json({ msg: "Server error", error: err.message });
    }
});

router.delete("/:id/workers/:workerId", authAdmin, async (req, res) => {
    try {
        const businessId = (req.params.id ?? "").trim();
        const workerId = (req.params.workerId ?? "").trim();
        const { business } = req.tokenData;

        if (!isValidObjectId(businessId)) return res.status(400).json({ msg: "Invalid id" });
        if (business && business !== businessId) return res.status(403).json({ msg: "Access denied" });

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
        console.error("DELETE /workers error:", err);
        res.status(500).json({ msg: "Server error", error: err.message });
    }
});

module.exports = router;