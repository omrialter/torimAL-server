/**
 * Normalizes a phone number to E.164 format for Israel (+972)
 * Removes non-digit characters (dashes, spaces, parens)
 * @param {string} raw - The raw input string
 * @returns {string} - Formatted phone number or original if invalid
 */
exports.toE164IL = (raw) => {
    if (!raw || typeof raw !== "string") return raw;

    // 1. Remove all non-digit characters (e.g. "050-123" -> "050123")
    let clean = raw.replace(/\D/g, "");

    // 2. Check if it already starts with 972 (Israel Country Code)
    if (clean.startsWith("972")) {
        return "+" + clean;
    }

    // 3. If starts with '0', replace with '+972'
    if (clean.startsWith("0")) {
        return clean.replace(/^0/, "+972");
    }

    // Return cleaned version (fallback)
    return clean;
};