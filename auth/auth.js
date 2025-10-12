const jwt = require("jsonwebtoken");
const { config } = require("../config/secret");

exports.auth = (req, res, next) => {
    const token = req.header("x-api-key");

    if (typeof token !== "string" || token.trim() === "") {
        return res.status(401).json({ msg: "Token must be provided in x-api-key header" });
    }

    try {
        const decodedToken = jwt.verify(token, config.tokenSecret);
        req.tokenData = decodedToken;
        next();
    } catch (err) {
        if (err.name === "TokenExpiredError") {
            return res.status(401).json({ msg: "Token has expired" });

        }

        console.error("JWT Verification Error:", err.message);
        return res.status(401).json({ msg: "Invalid token" });
    }
};

exports.authAdmin = (req, res, next) => {
    const token = req.header("x-api-key");

    if (typeof token !== "string" || token.trim() === "") {
        return res.status(401).json({ err: "Token must be provided in x-api-key header" });
    }

    try {
        const decodedToken = jwt.verify(token, config.tokenSecret);

        if (decodedToken.role !== "admin") {
            return res.status(403).json({ err: "Access denied – admin only" });
        }

        req.tokenData = decodedToken;
        next();
    } catch (err) {
        if (err.name === "TokenExpiredError") {
            return res.status(401).json({ err: "Token has expired" });
        }

        console.error("JWT Admin Verification Error:", err.message);
        return res.status(401).json({ err: "Invalid token" });
    }
};
