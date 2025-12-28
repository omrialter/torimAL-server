const mongoose = require("mongoose");
const Joi = require("joi");

const DEFAULT_OPENING_HOURS = {
    sunday: { open: "09:00", close: "17:00" },
    monday: { open: "09:00", close: "17:00" },
    tuesday: { open: "09:00", close: "17:00" },
    wednesday: { open: "09:00", close: "17:00" },
    thursday: { open: "09:00", close: "17:00" },
    friday: { open: "09:00", close: "13:00" },
    saturday: { open: null, close: null }, // Closed
};

// Service Sub-schema (No explicit _id required, Mongoose adds it automatically)
const serviceSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true,
    },
    duration: {
        type: Number, // in minutes
        required: true,
        min: 1,
        max: 480,
    },
    price: {
        type: Number,
        required: true,
        min: 0,
    },
});

const businessSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    phone: { type: String, default: "" },
    email: { type: String, default: "" },
    address: { type: String, default: "" },

    // Business Owner (Reference to User)
    owner: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "users",

    },

    // Workers List (Array of User References)
    workers: [
        {
            type: mongoose.Schema.Types.ObjectId,
            ref: "users",
        },
    ],

    // Image Gallery
    portfolio: {
        type: [String],
        default: () => [],
    },

    // Main Banner (Image or Video)
    banner: { type: String, default: "" },

    // Secondary Banners (Images)
    banner2: { type: String, default: "" },
    banner3: { type: String, default: "" },

    // Pop-up Message text
    message: { type: String, default: "" },

    // "About Us" text
    aboutUs: { type: String, default: "" },

    // List of Services
    services: {
        type: [serviceSchema],
        default: () => [],
    },

    // Brand Colors (Primary, Secondary, Third)
    business_colors: {
        primary: { type: String, default: "#111" },
        secondary: { type: String, default: "#f3f4f6" },
        third: { type: String, default: "#fff" },
    },

    openingHours: {
        type: Object,
        default: () => ({ ...DEFAULT_OPENING_HOURS }),
    },

    createdAt: { type: Date, default: Date.now },
});

exports.BusinessModel = mongoose.model("businesses", businessSchema);

// ---------------------------------------------------------
// Joi Validation (for Business Creation)
// ---------------------------------------------------------

exports.validateBusiness = (reqBody) => {
    const timeRange = Joi.object({
        open: Joi.string()
            .allow(null)
            .pattern(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/)
            .allow(""),
        close: Joi.string()
            .allow(null)
            .pattern(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/)
            .allow(""),
    });

    const joiSchema = Joi.object({
        name: Joi.string().min(2).max(200).required(),
        phone: Joi.string().min(6).max(20),
        email: Joi.string().max(200).email().required(),
        address: Joi.string().max(300),

        // Optional Media & Texts
        banner: Joi.string().uri().allow(""),
        banner2: Joi.string().uri().allow(""),
        banner3: Joi.string().uri().allow(""),
        message: Joi.string().max(4000).allow(""),
        aboutUs: Joi.string().max(8000).allow(""),

        portfolio: Joi.array().items(Joi.string().uri()),

        // Colors
        business_colors: Joi.object({
            primary: Joi.string().max(20).required(),
            secondary: Joi.string().max(20).required(),
            third: Joi.string().max(20).required(),
        }).optional(),

        // References
        owner: Joi.string().hex().length(24),
        workers: Joi.array().items(Joi.string().hex().length(24)),

        // Services Definition
        services: Joi.array().items(
            Joi.object({
                name: Joi.string().min(1).max(100).required(),
                duration: Joi.number().min(1).max(480).required(),
                price: Joi.number().min(0).required(),
            })
        ),

        openingHours: Joi.object({
            sunday: timeRange,
            monday: timeRange,
            tuesday: timeRange,
            wednesday: timeRange,
            thursday: timeRange,
            friday: timeRange,
            saturday: timeRange,
        }).optional(),
    });

    return joiSchema.validate(reqBody);
};