const jwt = require("jsonwebtoken");
const { config } = require("../config/secret");

// -------------------------
// USER AUTHENTICATION
// -------------------------
exports.auth = (req, res, next) => {
    const token = req.header("x-api-key");

    if (!token || typeof token !== "string" || token.trim() === "") {
        return res.status(401).json({ error: "Token must be provided in x-api-key header" });
    }

    try {
        const decoded = jwt.verify(token, config.tokenSecret);

        if (!decoded.business) {
            return res.status(401).json({ error: "Token missing business identifier" });
        }

        req.tokenData = decoded;
        next();
    } catch (err) {
        if (err.name === "TokenExpiredError") {
            return res.status(401).json({ error: "Token has expired" });
        }

        console.error("JWT Verification Error:", err.message);
        return res.status(401).json({ error: "Invalid token" });
    }
};


// -------------------------
// ADMIN AUTHENTICATION
// -------------------------
exports.authAdmin = (req, res, next) => {
    const token = req.header("x-api-key");

    if (!token || typeof token !== "string" || token.trim() === "") {
        return res.status(401).json({ error: "Token must be provided in x-api-key header" });
    }

    try {
        const decoded = jwt.verify(token, config.tokenSecret);

        if (!decoded.business) {
            return res.status(401).json({ error: "Token missing business identifier" });
        }

        if (decoded.role !== "admin") {
            return res.status(403).json({ error: "Access denied – admin only" });
        }

        req.tokenData = decoded;
        next();
    } catch (err) {
        if (err.name === "TokenExpiredError") {
            return res.status(401).json({ error: "Token has expired" });
        }

        console.error("JWT Admin Verification Error:", err.message);
        return res.status(401).json({ error: "Invalid token" });
    }
};
