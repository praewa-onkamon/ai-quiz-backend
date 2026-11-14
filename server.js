
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");

const app = express();
const PORT = process.env.PORT || 3000;
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";

app.use(cors());
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif"
    ];

    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("รองรับเฉพาะ JPG, PNG, WEBP หรือ GIF"));
    }

    cb(null, true);
  }
});

// หน้าแรกสำหรับตรวจสอบ Backend
app.get("/", (req, res) => {
  res.json({ message: "AI Smart Quiz Backend is running with Gemini" });
});

// ตรวจสอบสถานะระบบ
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    provider: "Google Gemini",
    model: MODEL
  });
});

// สร้างข้อสอบจากภาพ
app.post("/api/generate-quiz", upload.single("image"), async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error: "ไม่พบ GEMINI_API_KEY กรุณาตรวจสอบไฟล์ .env"
      });
    }

    if (!req.file) {
      return res.status(400).json({
        error: "กรุณาแนบภาพเนื้อหาการเรียน"
      });
    }

    const questionCount = Math.min(
      20,
      Math.max(1, parseInt(req.body.questionCount || "10", 10) || 10)
    );

    const difficulty = req.body.difficulty || "ปานกลาง";
    const quizType = req.body.quizType || "ปรนัย 4 ตัวเลือก";

    const imageBase64 = req.file.buffer.toString("base64");

    const prompt = `
คุณเป็นผู้เชี่ยวชาญด้านการศึกษาและการสร้างข้อสอบ

โปรดอ่านข้อความจากภาพและสร้างข้อสอบภาษาไทย
โดยยึดเนื้อหาจากภาพเท่านั้น

จำนวนข้อ: ${questionCount}
ระดับความยาก: ${difficulty}
รูปแบบ: ${quizType}

ข้อกำหนด:
1. ปรนัยต้องมี 4 ตัวเลือก และคำตอบถูกเพียงข้อเดียว
2. อัตนัยต้องมีแนวคำตอบ
3. แบบผสมต้องมีทั้งปรนัยและอัตนัย
4. ทุกข้อมีเฉลยและคำอธิบาย
5. ห้ามสร้างคำถามซ้ำ
6. คำถามต้องชัดเจน ไม่กำกวม
7. ตัวเลือกต้องสมเหตุสมผล
8. ห้ามแต่งข้อมูลที่ไม่มีในภาพ
9. หากอ่านข้อความในภาพไม่ชัด ให้แจ้งเตือนใน suggestions
10. สร้างข้อสอบให้ครบตามจำนวนที่กำหนด หากเนื้อหาเพียงพอ

หลังสร้างข้อสอบ ให้ทำ Quality Check โดยตรวจสอบ:
- ความถูกต้องของคำตอบ
- ความชัดเจนของคำถาม
- การตรวจสอบข้อสอบซ้ำ
- ความเหมาะสมของระดับความยาก
- คุณภาพของตัวเลือกและแนวคำตอบ

ให้คะแนนคุณภาพ 0-100 ตามผลที่ตรวจพบจริง

ตอบกลับเป็น JSON เท่านั้น ตามโครงสร้างนี้:

{
  "summary": "สรุปเนื้อหา",
  "questions": [
    {
      "number": 1,
      "type": "ปรนัย",
      "question": "คำถาม",
      "options": ["ตัวเลือก ก", "ตัวเลือก ข", "ตัวเลือก ค", "ตัวเลือก ง"],
      "answer": "เฉลย",
      "explanation": "คำอธิบาย",
      "difficulty": "ปานกลาง"
    }
  ],
  "qualityCheck": {
    "score": 85,
    "passed": true,
    "checks": [
      {
        "name": "ความถูกต้องของคำตอบ",
        "score": 90,
        "status": "ผ่าน",
        "detail": "รายละเอียด"
      }
    ],
    "issues": [],
    "suggestions": [],
    "needsHumanReview": true
  }
}

คะแนนเป็นเพียงการประเมินจาก AI
ไม่ใช่การรับประกันว่าข้อสอบถูกต้อง 100%
`;

    // ส่งภาพและข้อความไปยัง Google Gemini API
    const apiUrl =
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

    const geminiResponse = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: prompt },
              {
                inlineData: {
                  mimeType: req.file.mimetype,
                  data: imageBase64
                }
              }
            ]
          }
        ],
        generationConfig: {
          responseMimeType: "application/json",
          maxOutputTokens: 7000,
          temperature: 0.4
        }
      })
    });

    const geminiData = await geminiResponse.json();

    if (!geminiResponse.ok) {
      console.error("Gemini API error:", geminiData);

      const apiError =
        geminiData.error?.message || "ไม่สามารถเรียกใช้งาน Gemini API ได้";

      if (geminiResponse.status === 400) {
        throw new Error(`คำขอไม่ถูกต้อง: ${apiError}`);
      }

      if (geminiResponse.status === 401 || geminiResponse.status === 403) {
        throw new Error("Gemini API Key ไม่ถูกต้อง หรือไม่มีสิทธิ์ใช้งาน API");
      }

      if (geminiResponse.status === 429) {
        throw new Error(
          "ใช้งาน Gemini เกินโควตาฟรีแล้ว กรุณารอสักครู่หรือตรวจสอบ Usage Limits"
        );
      }

      throw new Error(apiError);
    }

    const responseText =
      geminiData.candidates?.[0]?.content?.parts
        ?.map(part => part.text || "")
        .join("")
        .trim();

    if (!responseText) {
      throw new Error("Gemini ไม่ได้ส่งผลลัพธ์กลับมา กรุณาลองใหม่");
    }

    // แปลงข้อความ JSON จาก Gemini
    const data = JSON.parse(responseText);

    const qc = data.qualityCheck || {};
    const questions = Array.isArray(data.questions)
      ? data.questions
      : [];

    const resultLines = [
      "📚 สรุปเนื้อหา",
      data.summary || "ไม่มีสรุป",
      "",
      "📝 ข้อสอบ",
      ...questions.flatMap((q, i) => {
        const lines = [
          `${q.number || i + 1}. ${q.question || ""}`
        ];

        if (Array.isArray(q.options)) {
          lines.push(
            ...q.options.map((option, j) =>
              `   ${["ก", "ข", "ค", "ง"][j] || j + 1}. ${option}`
            )
          );
        }

        lines.push(`   เฉลย: ${q.answer || "ไม่มีข้อมูล"}`);

        if (q.explanation) {
          lines.push(`   คำอธิบาย: ${q.explanation}`);
        }

        lines.push("");
        return lines;
      }),

      "🔍 QUALITY CHECK - ตรวจสอบคุณภาพข้อสอบ",
      `คะแนนคุณภาพ: ${qc.score ?? "-"}/100`,
      `สถานะ: ${qc.passed ? "ผ่านเกณฑ์เบื้องต้น" : "ควรตรวจทาน/ปรับปรุง"}`,
      "",
      "รายละเอียดการตรวจสอบ:",

      ...(Array.isArray(qc.checks)
        ? qc.checks.map(x =>
            `- ${x.name}: ${x.score ?? "-"}/100 (${x.status || "ไม่ระบุ"}) — ${x.detail || ""}`
          )
        : ["ยังไม่มีรายละเอียด"]),

      "",
      "ประเด็นที่พบ:",

      ...(Array.isArray(qc.issues) && qc.issues.length
        ? qc.issues.map(x => `- ${x}`)
        : ["- ไม่พบประเด็นที่ AI ระบุ"]),

      "",
      "ข้อเสนอแนะ:",

      ...(Array.isArray(qc.suggestions) && qc.suggestions.length
        ? qc.suggestions.map(x => `- ${x}`)
        : ["- ไม่มี"]),

      "",
      "หมายเหตุ: ควรให้ผู้สอนตรวจทานก่อนนำไปใช้จริง"
    ];

    res.json({
      success: true,
      result: resultLines.join("\n"),
      summary: data.summary || "",
      questions,
      qualityCheck: qc
    });

  } catch (error) {
    console.error("generate-quiz error:", error);

    res.status(500).json({
      error: error.message || "เกิดข้อผิดพลาดในระบบ"
    });
  }
});

// จัดการข้อผิดพลาดจากการอัปโหลดภาพ
app.use((error, req, res, next) => {
  console.error("Server error:", error);

  res.status(400).json({
    error: error.message || "คำขอไม่ถูกต้อง"
  });
});

// เปิด Backend
app.listen(PORT, () => {
  console.log(
    `AI Smart Quiz Backend running at http://localhost:${PORT}`
  );

  console.log(`Using provider: Google Gemini`);
  console.log(`Using model: ${MODEL}`);
});
