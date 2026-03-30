module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { imageBase64, mediaType, extra } = req.body;
  if (!imageBase64) return res.status(400).json({ error: '缺少圖片資料' });

  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) return res.status(500).json({ error: 'API Key 未設定' });

  // ── Step 1: 辨識藥物 ──────────────────────────────────────────────
  const recognizePrompt = `你是一位精神科藥物辨識AI。這是診所系統的處方截圖（通常是表格）。
請辨識截圖中所有被開立的藥物，以純JSON格式回傳，不要任何其他文字。

格式：
{"drugs":[{"brand_name":"商品名","generic_name":"學名英文小寫","chinese_name":"中文名","dose":"劑量","frequency":"頻次如每日一次/早晚各一","timing":"服藥時機如飯後/睡前","days":"天數數字或null","quantity":"數量或null"}]}

注意：
- 若看到診所代碼(如BUR00/RIT00/YOU10等)也請對應辨識
- frequency請翻譯成中文(QD=每日一次, BID=每日兩次, TID=每日三次, HS=睡前)
- 若截圖模糊請盡量推測${extra ? `\n\n補充說明：${extra}` : ''}`;

  try {
    const r1 = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inline_data: { mime_type: mediaType || 'image/jpeg', data: imageBase64 } },
              { text: recognizePrompt }
            ]
          }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.1 }
        })
      }
    );

    const d1 = await r1.json();
    if (d1.error) throw new Error(d1.error.message);
    const rawDrugs = d1.candidates?.[0]?.content?.parts?.[0]?.text || '{"drugs":[]}';
    const { drugs } = JSON.parse(rawDrugs);
    if (!drugs?.length) return res.status(200).json({ drugs: [], edu: [] });

    // ── Step 2: 生成衛教說明 ──────────────────────────────────────
    const eduPrompt = `你是一位資深精神科護理師，使用繁體中文。請為以下藥物生成衛教說明，以純JSON格式回傳。

藥物列表：
${drugs.map((d,i)=>`[${i}] ${d.brand_name||''} (${d.generic_name||''}) ${d.dose||''} ${d.frequency||''} ${d.timing||''}`).join('\n')}

格式：
{"edu":[{"index":0,"purpose":"此藥用途一句話口語化例如幫助穩定情緒改善睡眠","schedule_times":["07:00 早餐後","22:00 睡前"],"warnings":["重要警語1","警語2","警語3"],"side_effects":["副作用1","副作用2"],"appearance":"藥物外觀描述顏色形狀刻字","patient_note":"給病患的溫馨叮嚀1-2句口語化"}]}

要求：
- schedule_times 請根據 frequency 和 timing 推算實際時間點
- warnings 請針對該藥物類別給出最重要的3條注意事項
- side_effects 列出最常見的3-4個
- patient_note 要溫暖易懂，像護理師在跟病患說話`;

    const r2 = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: eduPrompt }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.3 }
        })
      }
    );

    const d2 = await r2.json();
    if (d2.error) throw new Error(d2.error.message);
    const rawEdu = d2.candidates?.[0]?.content?.parts?.[0]?.text || '{"edu":[]}';
    const { edu } = JSON.parse(rawEdu);

    return res.status(200).json({ drugs, edu: edu || [] });

  } catch (err) {
    console.error('Analyse error:', err);
    return res.status(500).json({ error: err.message || '分析失敗，請重試' });
  }
}
