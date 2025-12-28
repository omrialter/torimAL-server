// services/firebase.js
const admin = require("firebase-admin");

const {
    FB_PROJECT_ID,
    FB_PRIVATE_KEY_ID,
    FB_PRIVATE_KEY,
    FB_CLIENT_EMAIL,
    FB_CLIENT_ID,
    FB_CLIENT_X509_CERT_URL,
    FB_UNIVERSE_DOMAIN,
} = process.env;

// Validate critical variables before attempting to initialize
if (!FB_PROJECT_ID || !FB_PRIVATE_KEY || !FB_CLIENT_EMAIL) {
    throw new Error("FATAL ERROR: Missing required Firebase environment variables.");
}

/**
 * Construct the Service Account object manually from environment variables.
 * This avoids committing the sensitive 'serviceAccountKey.json' file to version control.
 */
const serviceAccount = {
    type: "service_account",
    project_id: FB_PROJECT_ID,
    private_key_id: FB_PRIVATE_KEY_ID,
    // Fix for newline characters in environment variables (common issue in cloud hosting)
    private_key: FB_PRIVATE_KEY.replace(/\\n/g, "\n"),
    client_email: FB_CLIENT_EMAIL,
    client_id: FB_CLIENT_ID,
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
    auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
    client_x509_cert_url: FB_CLIENT_X509_CERT_URL,
    universe_domain: FB_UNIVERSE_DOMAIN,
};

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});

module.exports = admin;