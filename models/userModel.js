const mongoose = require("mongoose");
const Joi = require("joi");
const jwt = require("jsonwebtoken");
const { config } = require("../config/secret");

const userSchema = new mongoose.Schema({
    business: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "businesses",
        required: true
    },
    phone: {
        type: String,
        required: true,
    },
    name: {
        type: String,
        default: ""
    },
    role: {
        type: String,
        enum: ["user", "admin"],
        default: "user"
    },
    date_created: {
        type: Date,
        default: Date.now
    }
});

// 1) טלפון ייחודי בתוך אותו עסק (user או admin)
userSchema.index({ business: 1, phone: 1 }, { unique: true });

// 2) אותו טלפון לא יכול להיות admin בשני עסקים שונים
userSchema.index(
    { phone: 1 },
    {
        unique: true,
        partialFilterExpression: { role: "admin" }
    }
);

exports.UserModel = mongoose.model("users", userSchema);

exports.createToken = (user_id, role, businessId) => {
    const token = jwt.sign(
        { _id: user_id, role: role, business: businessId },
        config.tokenSecret,
        { expiresIn: "2d" }
    );
    return token;
};

exports.validateUser = (_reqBody) => {
    let joiSchema = Joi.object({
        business: Joi.string().hex().length(24).required(),
        name: Joi.string().min(2).max(200).required(),
        phone: Joi.string()
            .pattern(/^05\d{8}$/)
            .required()
    });
    return joiSchema.validate(_reqBody);
};

exports.validatePhoneOnly = (_reqBody) => {
    const joiSchema = Joi.object({
        phone: Joi.string()
            .pattern(/^05\d{8}$/)
            .required()
    });
    return joiSchema.validate(_reqBody);
};
