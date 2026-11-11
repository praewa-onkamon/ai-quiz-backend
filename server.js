
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const OpenAI = require('openai');

const app = express();

app.use(cors());
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

const ai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.post('/api/generate-quiz', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: 'กรุณาเลือกรูปภาพ'
      });
    }

    const base64 = req.file.buffer.toString('base64');

    const response = await ai.responses.create({
      model: process.env.OPENAI_MODEL,
      input: [{
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: `อ่านข้อความจากภาพ สรุปเป็นภาษาไทย และสร้างข้อสอบ
            จำนวน ${req.body.questionCount || 10} ข้อ
            ระดับ ${req.body.difficulty || 'ปานกลาง'}
            พร้อมตัวเลือก เฉลย และคำอธิบาย`
          },
          {
            type: 'input_image',
            image_url: `data:${req.file.mimetype};base64,${base64}`
          }
        ]
      }]
    });

    res.json({
      success: true,
      result: response.output_text
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: 'AI วิเคราะห์ไม่สำเร็จ'
    });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log('AI Backend running at http://localhost:3000');
});
