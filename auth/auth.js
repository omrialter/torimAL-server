const jwt = require("jsonwebtoken");

/**
 * Internal Helper: Verifies the JWT token and returns the decoded payload.
 * Throws errors to be caught by the middleware.
 */
const verifyToken = (token) => {
    if (!process.env.JWT_SECRET) {
        throw new Error("Server Error: JWT_SECRET is not defined.");
    }
    return jwt.verify(token, process.env.JWT_SECRET);
};

// -------------------------
// MIDDLEWARE: USER AUTHENTICATION
// -------------------------
exports.auth = (req, res, next) => {
    const token = req.header("x-api-key");

    if (!token || typeof token !== "string" || !token.trim()) {
        return res.status(401).json({ error: "Token must be provided in x-api-key header" });
    }

    try {
        const decoded = verifyToken(token);

        // Validate Business Context
        if (!decoded.business) {
            return res.status(401).json({ error: "Token is missing business identifier" });
        }

        req.tokenData = decoded;
        next();
    } catch (err) {
        if (err.name === "TokenExpiredError") {
            return res.status(401).json({ error: "Token has expired" });
        }
        // Log only critical errors, keep client response generic for security
        console.error("Auth Error:", err.message);
        return res.status(401).json({ error: "Invalid token or signature" });
    }
};

// -------------------------
// MIDDLEWARE: ADMIN AUTHENTICATION
// -------------------------
exports.authAdmin = (req, res, next) => {
    const token = req.header("x-api-key");

    if (!token || typeof token !== "string" || !token.trim()) {
        return res.status(401).json({ error: "Token must be provided in x-api-key header" });
    }

    try {
        const decoded = verifyToken(token);

        // Validate Business Context
        if (!decoded.business) {
            return res.status(401).json({ error: "Token is missing business identifier" });
        }

        // Validate Admin Role
        if (decoded.role !== "admin") {
            return res.status(403).json({ error: "Access denied: Admin privileges required" });
        }

        req.tokenData = decoded;
        next();
    } catch (err) {
        if (err.name === "TokenExpiredError") {
            return res.status(401).json({ error: "Token has expired" });
        }
        console.error("Admin Auth Error:", err.message);
        return res.status(401).json({ error: "Invalid token or signature" });
    }
};