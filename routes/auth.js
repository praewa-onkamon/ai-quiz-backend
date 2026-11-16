
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { pool } = require("../db");

const router = express.Router();

// สร้าง JWT Token
function createToken(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email
    },
    process.env.JWT_SECRET,
    {
      expiresIn: "7d"
    }
  );
}

// สมัครสมาชิก
router.post("/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        error: "กรุณากรอกข้อมูลให้ครบถ้วน"
      });
    }

    const cleanName = name.trim();
    const cleanEmail = email.trim().toLowerCase();

    if (!cleanName || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return res.status(400).json({
        success: false,
        error: "ชื่อหรืออีเมลไม่ถูกต้อง"
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        error: "รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร"
      });
    }

    const existingUser = await pool.query(
      "SELECT id FROM users WHERE email = $1",
      [cleanEmail]
    );

    if (existingUser.rows.length > 0) {
      return res.status(409).json({
        success: false,
        error: "อีเมลนี้ถูกใช้งานแล้ว"
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, name, email, created_at`,
      [cleanName, cleanEmail, passwordHash]
    );

    const user = result.rows[0];
    const token = createToken(user);

    return res.status(201).json({
      success: true,
      message: "สมัครสมาชิกสำเร็จ",
      token,
      user
    });

  } catch (error) {
    console.error("Register error:", error.message);

    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        error: "อีเมลนี้ถูกใช้งานแล้ว"
      });
    }

    return res.status(500).json({
      success: false,
      error: "เกิดข้อผิดพลาดในการสมัครสมาชิก"
    });
  }
});

// เข้าสู่ระบบ
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: "กรุณากรอกอีเมลและรหัสผ่าน"
      });
    }

    const cleanEmail = email.trim().toLowerCase();

    const result = await pool.query(
      `SELECT id, name, email, password_hash, created_at
       FROM users
       WHERE email = $1`,
      [cleanEmail]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        error: "อีเมลหรือรหัสผ่านไม่ถูกต้อง"
      });
    }

    const user = result.rows[0];

    const isMatch = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!isMatch) {
      return res.status(401).json({
        success: false,
        error: "อีเมลหรือรหัสผ่านไม่ถูกต้อง"
      });
    }

    const token = createToken(user);

    return res.json({
      success: true,
      message: "เข้าสู่ระบบสำเร็จ",
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        created_at: user.created_at
      }
    });

  } catch (error) {
    console.error("Login error:", error.message);

    return res.status(500).json({
      success: false,
      error: "เกิดข้อผิดพลาดในการเข้าสู่ระบบ"
    });
  }
});

// ตรวจสอบบัญชีผู้ใช้ปัจจุบัน
router.get("/me", require("../middleware/auth"), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, created_at
       FROM users
       WHERE id = $1`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "ไม่พบบัญชีผู้ใช้"
      });
    }

    return res.json({
      success: true,
      user: result.rows[0]
    });

  } catch (error) {
    console.error("Get user error:", error.message);

    return res.status(500).json({
      success: false,
      error: "ไม่สามารถตรวจสอบบัญชีได้"
    });
  }
});

module.exports = router;
