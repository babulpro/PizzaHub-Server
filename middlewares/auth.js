import jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';
import { collections } from '../config/db.js';

/**
 * Middleware: Verify JWT and attach full user from database to req.user
 */
export async function verifyToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. No token provided.',
      });
    }

    const token = authHeader.split(' ')[1];

    // Verify token signature & expiry
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({
          success: false,
          message: 'Token has expired. Please sign in again.',
        });
      }
      return res.status(401).json({
        success: false,
        message: 'Invalid authorization token.',
      });
    }

    // Lookup user in MongoDB by ID or email
    let userQuery = {};
    if (decoded.id && ObjectId.isValid(decoded.id)) {
      userQuery = { _id: new ObjectId(decoded.id) };
    } else if (decoded.email) {
      userQuery = { email: decoded.email.toLowerCase() };
    } else {
      return res.status(401).json({
        success: false,
        message: 'Invalid token payload.',
      });
    }

    const user = await collections.users.findOne(userQuery);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'User belonging to this token no longer exists.',
      });
    }

    // Security check: Blocked users cannot access protected features
    if (user.isBlocked) {
      return res.status(403).json({
        success: false,
        message: 'Your account has been blocked by an administrator.',
      });
    }

    // Attach verified user to request
    req.user = user;
    next();
  } catch (error) {
    console.error('verifyToken error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error during authentication.',
    });
  }
}

/**
 * Middleware: Verify if user role is in the allowed roles list
 * Usage: verifyRole('admin') or verifyRole('vendor', 'admin')
 */
export function verifyRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required.',
      });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `Forbidden: This resource is restricted to ${allowedRoles.join(' or ')} accounts. Your role is '${req.user.role}'.`,
      });
    }

    next();
  };
}