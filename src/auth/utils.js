class AuthorizationError extends Error {}

const getExpiryTime = (fromNow) => new Date(new Date().getTime() + fromNow).toISOString()

const isExpired = (expiresAt) => new Date().getTime() >= new Date(expiresAt).getTime()

module.exports = { AuthorizationError, getExpiryTime, isExpired }
