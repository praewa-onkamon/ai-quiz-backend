
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { pool } = require("./db");
const authenticateToken = require("./middleware/auth");

// ==========================================
// 1. ตั้งค่าระบบหลัก
// ==========================================

const app = express();
const PORT = process.env.PORT || 3000;

const MODEL =
  process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";

app.use(cors());
app.use(express.json());

// ==========================================
// 2. ระบบสมัครสมาชิกและเข้าสู่ระบบ
// ==========================================

const authRoutes = require("./routes/auth");

app.use("/api/auth", authRoutes);

// ==========================================
// 3. ตั้งค่าการอัปโหลดภาพ
// ==========================================

const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: 10 * 1024 * 1024
  },

  fileFilter: (req, file, cb) => {
    const allowed = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif"
    ];

    if (!allowed.includes(file.mimetype)) {
      return cb(
        new Error("รองรับเฉพาะ JPG, PNG, WEBP หรือ GIF")
      );
    }

    cb(null, true);
  }
});

// ==========================================
// 4. ฟังก์ชันช่วยเหลือ
// ==========================================

function normalizeQuizType(value) {
  const type = String(value || "").trim();

  if (
    ["จับคู่", "จับคู่รูปภาพ", "จับคู่ภาพ"].includes(type)
  ) {
    return "matching";
  }

  if (
    ["ปรนัย", "ปรนัย 4 ตัวเลือก", "multiple choice"].includes(
      type.toLowerCase()
    )
  ) {
    return "multiple";
  }

  if (["อัตนัย", "essay"].includes(type.toLowerCase())) {
    return "essay";
  }

  if (
    ["ถูกหรือผิด", "ถูก/ผิด", "ถูกผิด", "true/false"].includes(
      type.toLowerCase()
    )
  ) {
    return "truefalse";
  }

  if (["ผสม", "mixed"].includes(type.toLowerCase())) {
    return "mixed";
  }

  return "custom";
}

function classifyQuestion(question) {
  if (
    question?.type === "จับคู่" ||
    (
      Array.isArray(question?.leftItems) &&
      Array.isArray(question?.rightItems)
    )
  ) {
    return "matching";
  }

  if (
    question?.type === "ถูกหรือผิด" ||
    (
      Array.isArray(question?.options) &&
      question.options.length === 2 &&
      question.options.includes("ถูก") &&
      question.options.includes("ผิด")
    )
  ) {
    return "truefalse";
  }

  if (
    question?.type === "อัตนัย" ||
    (
      !Array.isArray(question?.options) &&
      typeof question?.answer === "string"
    )
  ) {
    return "essay";
  }

  if (
    question?.type === "ปรนัย" ||
    Array.isArray(question?.options)
  ) {
    return "multiple";
  }

  return "unknown";
}

function validateMatchingQuestion(question) {
  const errors = [];

  const leftItems = question.leftItems;
  const rightItems = question.rightItems;
  const answers = question.answer;

  if (!Array.isArray(leftItems) || leftItems.length < 2) {
    errors.push("รายการฝั่งซ้ายต้องมีอย่างน้อย 2 รายการ");
  }

  if (!Array.isArray(rightItems) || rightItems.length < 2) {
    errors.push("รายการฝั่งขวาต้องมีอย่างน้อย 2 รายการ");
  }

  if (!Array.isArray(answers) || answers.length === 0) {
    errors.push("ไม่มีข้อมูลเฉลยการจับคู่");
  }

  if (errors.length > 0) {
    return errors;
  }

  const leftIds = leftItems.map(item => item.id);
  const rightIds = rightItems.map(item => item.id);

  if (leftIds.some(id => id === undefined || id === null || id === "")) {
    errors.push("รายการฝั่งซ้ายมี ID ไม่ถูกต้อง");
  }

  if (rightIds.some(id => id === undefined || id === null || id === "")) {
    errors.push("รายการฝั่งขวามี ID ไม่ถูกต้อง");
  }

  if (new Set(leftIds).size !== leftIds.length) {
    errors.push("ID ของรายการฝั่งซ้ำกัน");
  }

  if (new Set(rightIds).size !== rightIds.length) {
    errors.push("ID ของรายการฝั่งขวาซ้ำกัน");
  }

  if (
    leftItems.some(item => !String(item.text || "").trim()) ||
    rightItems.some(item => !String(item.text || "").trim())
  ) {
    errors.push("รายการจับคู่มีข้อความว่าง");
  }

  const usedLeft = new Set();
  const usedRight = new Set();

  for (const pair of answers) {
    if (!pair || pair.left === undefined || pair.right === undefined) {
      errors.push("พบรูปแบบคู่คำตอบไม่ถูกต้อง");
      continue;
    }

    if (!leftIds.includes(pair.left)) {
      errors.push(`ไม่พบ ID ฝั่งซ้าย ${pair.left}`);
    }

    if (!rightIds.includes(pair.right)) {
      errors.push(`ไม่พบ ID ฝั่งขวา ${pair.right}`);
    }

    if (usedLeft.has(pair.left)) {
      errors.push(`รายการฝั่งซ้าย ${pair.left} มีคำตอบซ้ำ`);
    }

    if (usedRight.has(pair.right)) {
      errors.push(`รายการฝั่งขวา ${pair.right} มีคำตอบซ้ำ`);
    }

    usedLeft.add(pair.left);
    usedRight.add(pair.right);
  }

  if (answers.length !== leftItems.length) {
    errors.push("จำนวนเฉลยไม่ตรงกับจำนวนรายการฝั่งซ้าย");
  }

  return [...new Set(errors)];
}

function validateQuestion(question, expectedType) {
  const errors = [];

  if (!question || typeof question !== "object") {
    return ["ข้อมูลข้อสอบไม่ถูกต้อง"];
  }

  if (!String(question.question || "").trim()) {
    errors.push("ไม่มีข้อความคำถาม");
  }

  if (
    question.answer === undefined ||
    question.answer === null ||
    question.answer === ""
  ) {
    errors.push("ไม่มีเฉลย");
  }

  if (!String(question.explanation || "").trim()) {
    errors.push("ไม่มีคำอธิบาย");
  }

  const actualType = classifyQuestion(question);

  if (
    expectedType !== "custom" &&
    expectedType !== "mixed" &&
    actualType !== expectedType
  ) {
    errors.push(
      `รูปแบบไม่ตรงกัน: ต้องการ ${expectedType} แต่ได้รับ ${actualType}`
    );
  }

  if (expectedType === "multiple") {
    if (
      !Array.isArray(question.options) ||
      question.options.length !== 4
    ) {
      errors.push("ข้อสอบปรนัยต้องมีตัวเลือก 4 ตัวเลือก");
    }

    if (
      Array.isArray(question.options) &&
      !question.options.includes(question.answer)
    ) {
      errors.push("เฉลยไม่ตรงกับตัวเลือก");
    }
  }

  if (expectedType === "truefalse") {
    if (
      !Array.isArray(question.options) ||
      question.options.length !== 2 ||
      !question.options.includes("ถูก") ||
      !question.options.includes("ผิด")
    ) {
      errors.push("ข้อสอบถูก/ผิดต้องมีตัวเลือกถูกและผิด");
    }

    if (!["ถูก", "ผิด"].includes(question.answer)) {
      errors.push("เฉลยต้องเป็นถูกหรือผิด");
    }
  }

  if (expectedType === "matching") {
    errors.push(...validateMatchingQuestion(question));
  }

  if (
    expectedType === "essay" &&
    typeof question.answer !== "string"
  ) {
    errors.push("ข้อสอบอัตนัยต้องมีแนวคำตอบเป็นข้อความ");
  }

  return [...new Set(errors)];
}

// ==========================================
// 5. หน้าแรกและตรวจสอบสถานะ Backend
// ==========================================

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "AI Smart Quiz Backend is running with Gemini"
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    provider: "Google Gemini",
    model: MODEL
  });
});

// ==========================================
// 6. สร้างข้อสอบด้วย Google Gemini
// ==========================================

app.post(
  "/api/generate-quiz",
  authenticateToken,
  upload.single("image"),
  async (req, res) => {
    try {
      // ------------------------------------------
      // 6.1 ตรวจสอบ API Key
      // ------------------------------------------

      const apiKey = process.env.GEMINI_API_KEY;

      if (!apiKey) {
        return res.status(500).json({
          success: false,
          error: "ไม่พบ GEMINI_API_KEY กรุณาตรวจสอบไฟล์ .env"
        });
      }

      // ------------------------------------------
      // 6.2 ตรวจสอบภาพ
      // ------------------------------------------

      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: "กรุณาแนบภาพเนื้อหาการเรียน"
        });
      }

      const imageBase64 =
        req.file.buffer.toString("base64");

      // ------------------------------------------
      // 6.3 รับค่าจาก Frontend
      // ------------------------------------------

      const requestedCount = Number(
        req.body.questionCount || 10
      );

      if (
        !Number.isInteger(requestedCount) ||
        requestedCount < 1 ||
        requestedCount > 20
      ) {
        return res.status(400).json({
          success: false,
          error: "ขณะนี้ระบบรองรับการสร้างข้อสอบครั้งละ 1–20 ข้อ"
        });
      }

      const questionCount = requestedCount;

      const difficulty = req.body.difficulty || "ปานกลาง";
      const quizType = req.body.quizType || "ปรนัย 4 ตัวเลือก";
      const expectedType = normalizeQuizType(quizType);

      const educationLevel = req.body.educationLevel || "ไม่ระบุ";
      const gradeLevel = req.body.gradeLevel || "ไม่ระบุ";
      const subject = req.body.subject || "ไม่ระบุ";
      const lessonTopic = req.body.lessonTopic || "ไม่ระบุ";
      const specialInstructions =
        req.body.specialInstructions || "ไม่มี";

      // ==========================================
      // 6.4 คำสั่งตามรูปแบบข้อสอบ
      // ==========================================

      let quizTypeInstruction = "";

      switch (expectedType) {
        case "multiple":
          quizTypeInstruction = `
- ทุกข้อเป็นข้อสอบปรนัย 4 ตัวเลือก
- ทุกข้อต้องมี options จำนวน 4 รายการ
- answer ต้องตรงกับข้อความใน options
- ต้องมีคำตอบถูกเพียงข้อเดียว
- ระบุ type เป็น "ปรนัย"
`;
          break;

        case "essay":
          quizTypeInstruction = `
- ทุกข้อเป็นข้อสอบอัตนัย
- ไม่ต้องมี options
- answer ต้องเป็นแนวคำตอบที่ถูกต้อง
- ต้องมี explanation
- ระบุ type เป็น "อัตนัย"
`;
          break;

        case "truefalse":
          quizTypeInstruction = `
- ทุกข้อเป็นข้อสอบถูกหรือผิด
- options ต้องเป็น ["ถูก", "ผิด"]
- answer ต้องเป็น "ถูก" หรือ "ผิด" เท่านั้น
- ระบุ type เป็น "ถูกหรือผิด"
`;
          break;

        case "mixed":
          quizTypeInstruction = `
- สร้างข้อสอบแบบผสมปรนัยและอัตนัย
- แบ่งจำนวนข้อให้ใกล้เคียง 50:50
- ปรนัยต้องมี options 4 ตัวเลือก
- อัตนัยต้องมี answer เป็นแนวคำตอบ
- ระบุ type ของแต่ละข้อให้ตรงกับรูปแบบ
`;
          break;

        case "matching":
          quizTypeInstruction = `
ข้อกำหนดสำคัญ: ทุกข้อจะต้องเป็นข้อสอบจับคู่ ห้ามสร้างเป็นปรนัย

โครงสร้างของแต่ละข้อ:
- type ต้องเป็น "จับคู่"
- question ต้องบอกคำสั่งให้จับคู่
- leftItems เป็น Array รายการฝั่งซ้าย
- rightItems เป็น Array รายการฝั่งขวา
- แต่ละรายการต้องมี id และ text
- ควรมีรายการอย่างน้อย 3 คู่ หากเนื้อหาเพียงพอ
- สลับลำดับ rightItems ไม่ให้ตรงกับลำดับคำตอบ
- answer เป็น Array ของ Object เช่น:
  [
    {"left":"A","right":"2"},
    {"left":"B","right":"1"},
    {"left":"C","right":"3"}
  ]
- ค่า left และ right ต้องตรงกับ ID ที่มีอยู่จริง
- ห้ามใช้ ID ซ้ำ
- ต้องจับคู่ได้ครบทุกข้อ
- ทุกข้อมี explanation

ข้อมูลภาพ:
- สร้างคู่จับคู่จากเนื้อหาที่อ่านได้ในภาพ
- หากมีภาพสิ่งของ แผนภาพ หรือสัญลักษณ์ ให้ใช้ข้อมูลที่มองเห็นและยืนยันได้
- ห้ามเดารายละเอียดที่ไม่ปรากฏในภาพ
- imageUrl ให้เป็น null หากไม่มี URL ของภาพจริง
- imageSource ให้เป็น "none" หากไม่มีภาพประกอบจริง
- ห้ามสร้าง URL ปลอม
- ห้ามเปลี่ยนข้อสอบจับคู่เป็นปรนัย
`;
          break;

        default:
          quizTypeInstruction = `
- สร้างข้อสอบตามรูปแบบที่ผู้ใช้ระบุ: ${quizType}
- ต้องมีคำตอบและคำอธิบายทุกข้อ
- ระบุ type ให้ตรงกับรูปแบบจริง
`;
      }

      // ==========================================
      // 6.5 ตัวอย่าง JSON
      // ==========================================

      let sampleQuestions = [];

      if (expectedType === "matching") {
        sampleQuestions = [
          {
            number: 1,
            type: "จับคู่",
            question: "จับคู่รายการฝั่งซ้ายกับฝั่งขวาให้ถูกต้อง",
            leftItems: [
              { id: "A", text: "รายการที่หนึ่ง", imageUrl: null, imageSource: "none" },
              { id: "B", text: "รายการที่สอง", imageUrl: null, imageSource: "none" },
              { id: "C", text: "รายการที่สาม", imageUrl: null, imageSource: "none" }
            ],
            rightItems: [
              { id: "2", text: "คำอธิบายที่สอง", imageUrl: null, imageSource: "none" },
              { id: "3", text: "คำอธิบายที่สาม", imageUrl: null, imageSource: "none" },
              { id: "1", text: "คำอธิบายที่หนึ่ง", imageUrl: null, imageSource: "none" }
            ],
            answer: [
              { left: "A", right: "1" },
              { left: "B", right: "2" },
              { left: "C", right: "3" }
            ],
            explanation: "คำอธิบายหลักการจับคู่",
            difficulty: "ปานกลาง"
          }
        ];
      } else if (expectedType === "essay") {
        sampleQuestions = [
          {
            number: 1,
            type: "อัตนัย",
            question: "อธิบายเนื้อหาตามหัวข้อบทเรียน",
            answer: "แนวคำตอบตามเนื้อหาบทเรียน",
            explanation: "คำอธิบายประกอบแนวคำตอบ",
            difficulty: "ปานกลาง"
          }
        ];
      } else if (expectedType === "truefalse") {
        sampleQuestions = [
          {
            number: 1,
            type: "ถูกหรือผิด",
            question: "ข้อความตามเนื้อหาบทเรียนเป็นข้อความที่ถูกต้อง",
            options: ["ถูก", "ผิด"],
            answer: "ถูก",
            explanation: "คำอธิบายตามเนื้อหาบทเรียน",
            difficulty: "ปานกลาง"
          }
        ];
      } else if (expectedType === "mixed") {
        sampleQuestions = [
          {
            number: 1,
            type: "ปรนัย",
            question: "คำถามตัวอย่าง",
            options: ["ตัวเลือก ก", "ตัวเลือก ข", "ตัวเลือก ค", "ตัวเลือก ง"],
            answer: "ตัวเลือก ก",
            explanation: "คำอธิบายคำตอบ",
            difficulty: "ปานกลาง"
          },
          {
            number: 2,
            type: "อัตนัย",
            question: "อธิบายเนื้อหาตามหัวข้อบทเรียน",
            answer: "แนวคำตอบ",
            explanation: "คำอธิบายประกอบแนวคำตอบ",
            difficulty: "ปานกลาง"
          }
        ];
      } else {
        sampleQuestions = [
          {
            number: 1,
            type: "ปรนัย",
            question: "คำถามตัวอย่าง",
            options: ["ตัวเลือก ก", "ตัวเลือก ข", "ตัวเลือก ค", "ตัวเลือก ง"],
            answer: "ตัวเลือก ก",
            explanation: "คำอธิบายคำตอบ",
            difficulty: "ปานกลาง"
          }
        ];
      }

      const questionExampleJSON =
        JSON.stringify(sampleQuestions, null, 2);

      // ==========================================
      // 6.6 Prompt
      // ==========================================

      const prompt = `
คุณเป็นผู้เชี่ยวชาญด้านการศึกษา การวิเคราะห์เนื้อหา และการออกข้อสอบ

ภารกิจ:
วิเคราะห์ภาพที่ผู้ใช้อัปโหลด และสร้างข้อสอบภาษาไทยตามเงื่อนไขทั้งหมด

ข้อมูลผู้ใช้:
ระดับการศึกษา: ${educationLevel}
ระดับชั้น: ${gradeLevel}
รายวิชา: ${subject}
หัวข้อบทเรียน: ${lessonTopic}
จำนวนข้อ: ${questionCount}
ระดับความยาก: ${difficulty}
รูปแบบข้อสอบ: ${quizType}
คำสั่งเพิ่มเติม: ${specialInstructions}

หลักการ:
1. ยึดเนื้อหาในภาพเป็นแหล่งข้อมูลหลัก
2. ใช้ภาษาให้เหมาะกับระดับการศึกษา
3. ห้ามสร้างเนื้อหาที่ไม่เกี่ยวข้อง
4. ห้ามเดาข้อมูลที่ไม่มีหลักฐาน
5. ห้ามสร้างคำถามซ้ำ
6. ทุกข้อต้องมีเฉลยและคำอธิบาย
7. หากเนื้อหาไม่เพียงพอให้แจ้งข้อจำกัด
8. ปฏิบัติตามคำสั่งเพิ่มเติมของผู้ใช้

ระดับความยาก:
- ง่าย: ความจำและความเข้าใจพื้นฐาน
- ปานกลาง: ความเข้าใจและการประยุกต์ใช้
- ยาก: การคิดวิเคราะห์และการแก้ปัญหา
- ผสม: กระจายระดับความยากให้เหมาะสม

ข้อกำหนดรูปแบบข้อสอบ:
${quizTypeInstruction}

ข้อกำหนดจำนวน:
- สร้าง ${questionCount} ข้อ
- หมายเลขข้อเรียงจาก 1 เป็นต้นไป
- ห้ามส่งคำถามซ้ำ
- ห้ามเปลี่ยนรูปแบบข้อสอบที่ผู้ใช้เลือก

QUALITY CHECK:
ตรวจสอบ:
1. ความตรงตามเนื้อหา
2. ความเหมาะสมกับระดับชั้น
3. ความถูกต้องของเฉลย
4. ความเหมาะสมของความยาก
5. รูปแบบข้อสอบถูกต้อง
6. จำนวนข้อครบ
7. คำถามไม่ซ้ำ
8. ภาษาเข้าใจง่าย
9. ยึดโยงกับภาพ
10. ทำตามคำสั่งเพิ่มเติม

ห้ามให้คะแนนเต็มโดยไม่มีหลักฐาน
needsHumanReview ต้องเป็น true เสมอ

ตอบเป็น JSON เท่านั้น ห้ามใช้ Markdown

โครงสร้าง JSON:
{
  "summary": "สรุปเนื้อหาจากภาพ",
  "questions": ${questionExampleJSON},
  "qualityCheck": {
    "score": 85,
    "passed": true,
    "checks": [
      {
        "name": "ความตรงตามเนื้อหา",
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

หมายเหตุ:
- ตัวอย่าง questions ใช้กำหนดโครงสร้างเท่านั้น
- ห้ามคัดลอกคำถามตัวอย่าง
- ทุกข้อมี answer และ explanation
- ข้อจับคู่ต้องมี leftItems, rightItems และ answer เป็น Array
- ข้ออัตนัยไม่ต้องมี options
- ข้อถูกผิดต้องมี options ["ถูก","ผิด"]
- คะแนน AI เป็นการประเมินเบื้องต้นเท่านั้น
`;

      // ==========================================
      // 6.7 เรียก Gemini API
      // ==========================================

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
            temperature: 0.3
          }
        })
      });

      const geminiData = await geminiResponse.json();

      // ==========================================
      // 6.8 ตรวจสอบข้อผิดพลาด Gemini
      // ==========================================

      if (!geminiResponse.ok) {
        console.error("Gemini API error:", geminiData);

        const apiError =
          geminiData.error?.message ||
          "ไม่สามารถเรียกใช้งาน Gemini API ได้";

        if (geminiResponse.status === 400) {
          throw new Error(`คำขอไม่ถูกต้อง: ${apiError}`);
        }

        if (
          geminiResponse.status === 401 ||
          geminiResponse.status === 403
        ) {
          throw new Error(
            "Gemini API Key ไม่ถูกต้อง หรือไม่มีสิทธิ์ใช้งาน API"
          );
        }

        if (geminiResponse.status === 429) {
          throw new Error(
            "ใช้งาน Gemini เกินโควตา กรุณารอสักครู่แล้วลองใหม่"
          );
        }

        throw new Error(apiError);
      }

      // ==========================================
      // 6.9 อ่านผลลัพธ์
      // ==========================================

      const responseText =
        geminiData.candidates?.[0]?.content?.parts
          ?.map(part => part.text || "")
          .join("")
          .trim();

      if (!responseText) {
        const finishReason =
          geminiData.candidates?.[0]?.finishReason;

        throw new Error(
          `Gemini ไม่ได้ส่งผลลัพธ์กลับมา (${finishReason || "ไม่ทราบสาเหตุ"})`
        );
      }

      let data;

      try {
        data = JSON.parse(responseText);
      } catch (error) {
        console.error("Gemini JSON parse error:", responseText);
        throw new Error(
          "AI ส่งข้อมูลไม่ใช่ JSON ที่ถูกต้อง กรุณาลองใหม่"
        );
      }

      const questions = Array.isArray(data.questions)
        ? data.questions
        : [];

      if (questions.length === 0) {
        throw new Error("AI ไม่ได้สร้างข้อสอบ");
      }

      // ==========================================
      // 6.10 ตรวจสอบรูปแบบข้อสอบจริง
      // ==========================================

      const validationErrors = [];

      questions.forEach((question, index) => {
        const errors = validateQuestion(question, expectedType);

        if (errors.length > 0) {
          validationErrors.push(
            `ข้อ ${index + 1}: ${errors.join(", ")}`
          );
        }
      });

      // ตรวจสอบรูปแบบผสม
      if (expectedType === "mixed") {
        const types = questions.map(classifyQuestion);

        if (
          !types.includes("multiple") ||
          !types.includes("essay")
        ) {
          validationErrors.push(
            "ข้อสอบแบบผสมต้องมีทั้งปรนัยและอัตนัย"
          );
        }
      }

      // หากรูปแบบผิด ให้หยุดก่อนบันทึกประวัติ
      if (validationErrors.length > 0) {
        console.error("Quiz validation failed:", validationErrors);

        return res.status(422).json({
          success: false,
          error:
            "AI สร้างข้อสอบไม่ตรงตามรูปแบบที่เลือก กรุณาลองสร้างใหม่",
          validationErrors
        });
      }

      // ==========================================
      // 6.11 ตรวจสอบจำนวนข้อและ Quality Check
      // ==========================================

      const originalQC =
        data.qualityCheck &&
        typeof data.qualityCheck === "object"
          ? data.qualityCheck
          : {};

      const qc = {
        ...originalQC,
        checks: Array.isArray(originalQC.checks)
          ? [...originalQC.checks]
          : [],
        issues: Array.isArray(originalQC.issues)
          ? [...originalQC.issues]
          : [],
        suggestions: Array.isArray(originalQC.suggestions)
          ? [...originalQC.suggestions]
          : [],
        needsHumanReview: true
      };

      const originalScore = Number(originalQC.score);

      let finalScore =
        Number.isFinite(originalScore) &&
        originalScore >= 0 &&
        originalScore <= 100
          ? Math.round(originalScore)
          : 60;

      if (questions.length !== questionCount) {
        qc.issues.push(
          `จำนวนข้อไม่ตรงตามที่ร้องขอ: ต้องการ ${questionCount} ข้อ แต่ AI สร้างได้ ${questions.length} ข้อ`
        );

        qc.suggestions.push(
          "ควรตรวจสอบจำนวนข้อและสร้างข้อสอบเพิ่มเติมให้ครบตามต้องการ"
        );

        finalScore = Math.min(finalScore, 70);
      }

      qc.checks.push({
        name: "การตรวจสอบรูปแบบข้อสอบโดย Backend",
        score: 100,
        status: "ผ่าน",
        detail: `ตรวจสอบรูปแบบ ${quizType} แล้ว พบข้อสอบที่ผ่านการตรวจสอบ ${questions.length} ข้อ`
      });

      qc.checks.push({
        name: "จำนวนข้อสอบ",
        score: questions.length === questionCount ? 100 : 50,
        status:
          questions.length === questionCount
            ? "ผ่าน"
            : "ไม่ผ่าน",
        detail:
          `ต้องการ ${questionCount} ข้อ และได้รับ ${questions.length} ข้อ`
      });

      if (questions.length !== questionCount) {
        finalScore = Math.min(finalScore, 70);
      }

      qc.score = finalScore;

      qc.passed =
        originalQC.passed === true &&
        questions.length === questionCount &&
        validationErrors.length === 0;

      // ==========================================
      // 6.12 จัดรูปแบบผลลัพธ์
      // ==========================================

      const resultLines = [
        "📚 สรุปเนื้อหา",
        data.summary || "ไม่มีสรุป",
        "",
        "📝 ข้อสอบ"
      ];

      questions.forEach((q, i) => {
        resultLines.push(
          `${q.number || i + 1}. ${q.question || ""}`
        );

        // ตัวเลือก
        if (Array.isArray(q.options)) {
          q.options.forEach((option, j) => {
            resultLines.push(
              `   ${["ก", "ข", "ค", "ง"][j] || j + 1}. ${option}`
            );
          });
        }

        // ข้อสอบจับคู่
        if (classifyQuestion(q) === "matching") {
          resultLines.push("   รายการฝั่งซ้าย:");

          q.leftItems.forEach(item => {
            resultLines.push(
              `      ${item.id}. ${item.text}`
            );
          });

          resultLines.push("   รายการฝั่งขวา:");

          q.rightItems.forEach(item => {
            resultLines.push(
              `      ${item.id}. ${item.text}`
            );
          });

          const matchingAnswers = q.answer.map(pair => {
            const left = q.leftItems.find(
              item => item.id === pair.left
            );

            const right = q.rightItems.find(
              item => item.id === pair.right
            );

            return (
              `${pair.left}. ${left?.text || ""}` +
              ` ↔ ${pair.right}. ${right?.text || ""}`
            );
          });

          // ใช้คำว่า เฉลย: เพื่อให้ PDF เดิมอ่านได้
          resultLines.push(
            `   เฉลย: ${matchingAnswers.join(" | ")}`
          );
        } else {
          resultLines.push(
            `   เฉลย: ${q.answer ?? "ไม่มีข้อมูล"}`
          );
        }

        if (q.explanation) {
          resultLines.push(
            `   คำอธิบาย: ${q.explanation}`
          );
        }

        resultLines.push("");
      });

      resultLines.push(
        "🔍 QUALITY CHECK - ตรวจสอบคุณภาพข้อสอบ"
      );

      resultLines.push(
        `คะแนนคุณภาพ: ${qc.score}/100`
      );

      resultLines.push(
        `สถานะ: ${
          qc.passed
            ? "ผ่านเกณฑ์เบื้องต้น"
            : "ควรตรวจทาน/ปรับปรุง"
        }`
      );

      resultLines.push("");
      resultLines.push("รายละเอียดการตรวจสอบ:");

      resultLines.push(
        ...qc.checks.map(item =>
          `- ${item.name}: ${item.score ?? "-"}/100 (${item.status || "ไม่ระบุ"}) — ${item.detail || ""}`
        )
      );

      resultLines.push("");
      resultLines.push("ประเด็นที่พบ:");

      resultLines.push(
        ...(qc.issues.length
          ? qc.issues.map(item => `- ${item}`)
          : ["- ไม่พบประเด็นที่ AI ระบุ"])
      );

      resultLines.push("");
      resultLines.push("ข้อเสนอแนะ:");

      resultLines.push(
        ...(qc.suggestions.length
          ? qc.suggestions.map(item => `- ${item}`)
          : ["- ไม่มี"])
      );

      resultLines.push("");
      resultLines.push(
        "หมายเหตุ: ควรให้ผู้สอนตรวจทานก่อนนำไปใช้จริง"
      );

      // ==========================================
      // 6.13 บันทึกประวัติ PostgreSQL
      // ==========================================

      const historyResult = await pool.query(
        `INSERT INTO quiz_history
          (user_id, summary, questions, quality_check, quality_score)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)
         RETURNING id, created_at`,
        [
          req.user.id,
          data.summary || "",
          JSON.stringify(questions),
          JSON.stringify(qc),
          qc.score
        ]
      );

      // ==========================================
      // 6.14 ส่งผลลัพธ์กลับ Frontend
      // ==========================================

      return res.json({
        success: true,

        result: resultLines.join("\n"),

        quizData: {
          summary: data.summary || "",
          questions,
          qualityCheck: qc
        },

        summary: data.summary || "",
        questions,
        qualityCheck: qc,

        historyId: historyResult.rows[0].id,
        historyCreatedAt: historyResult.rows[0].created_at
      });

    } catch (error) {
      console.error("generate-quiz error:", error);

      return res.status(500).json({
        success: false,
        error: error.message || "เกิดข้อผิดพลาดในระบบ"
      });
    }
  }
);

// ==========================================
// 7. จัดการข้อผิดพลาด
// ==========================================

app.use((error, req, res, next) => {
  console.error("Server error:", error);

  res.status(400).json({
    success: false,
    error: error.message || "คำขอไม่ถูกต้อง"
  });
});

// ==========================================
// 8. เปิดใช้งาน Backend
// ==========================================

app.listen(PORT, () => {
  console.log(
    `AI Smart Quiz Backend running at http://localhost:${PORT}`
  );

  console.log("Using provider: Google Gemini");
  console.log(`Using model: ${MODEL}`);
  console.log("Authentication routes: /api/auth");
  console.log("Quiz history: PostgreSQL");
  console.log("Authentication: JWT");
  console.log("Matching quiz validation: Enabled");
  console.log("Backend is ready!");
});
