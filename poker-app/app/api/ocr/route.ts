import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  try {
    const { base64Image, mimeType } = await req.json()

    if (!base64Image || !mimeType) {
      return NextResponse.json({ error: 'Missing base64Image or mimeType' }, { status: 400 })
    }

    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) {
      return NextResponse.json({ error: 'GEMINI_API_KEY not configured' }, { status: 500 })
    }

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`

    // Step 1 — Vision: describe what is literally visible on the sheet
    const describeResp = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inlineData: { mimeType, data: base64Image } },
            {
              text: `Look at this poker score sheet carefully. For each player row, describe EXACTLY what you see next to their name — specifically any vertical lines, tally marks, or numbers that represent buy-ins. Be very literal: count each individual stroke or line mark you can see. Also note the final chip count and any asterisk/star marker.

Format your response as a plain list, one player per line, like:
- Name: [name], marks: [describe exactly what you see, e.g. "3 vertical lines", "a tally group of 5 plus 2 extra lines", "the number 4", "no marks"], chips: [number or description], host marker: [yes/no]

Also note any date written on the sheet.`
            }
          ]
        }]
      })
    })

    if (!describeResp.ok) {
      const errBody = await describeResp.text()
      console.error('Gemini Vision API error:', describeResp.status, errBody)
      return NextResponse.json({ error: 'Gemini API error', status: describeResp.status, detail: errBody }, { status: 500 })
    }

    const descData = await describeResp.json()
    const description = descData.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text || '').join('') ?? ''

    if (!description) {
      console.error('Empty description from Gemini:', JSON.stringify(descData))
      return NextResponse.json({ error: 'Could not read image', detail: JSON.stringify(descData) }, { status: 500 })
    }

    // Step 2 — Text: parse description into structured JSON
    const parseResp = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{
            text: `You are a poker results data parser. You will receive a text description of a poker score sheet (already read by a vision model) and must convert it into structured JSON.

Return ONLY a valid JSON object with this exact structure, no markdown, no explanation:
{"date":"YYYY-MM-DD or null","players":[{"id":"1","name":"string","buyingCount":integer,"washoutChips":integer,"isHost":false,"confidence":{"name":0.0-1.0,"buyingCount":0.0-1.0,"washoutChips":0.0-1.0}}],"warnings":["string"]}

Rules for buyingCount:
- If the description says "N vertical lines" or "N marks/strokes" → buyingCount = N
- If the description says "a tally group of 5" → that group = 5. Add any extra lines on top.
- If the description says "the number N" → buyingCount = N
- If "no marks" or nothing mentioned → buyingCount = 1 (the initial buy-in)
- NEVER output 0 — minimum is 1

Rules for other fields:
- isHost: true if description mentions asterisk, star, or host marker next to the name
- name: clean name only, no asterisk or marker characters
- washoutChips: the final chip count (integer >= 0)
- date: if a date is mentioned in the description, convert to YYYY-MM-DD, else null
- confidence: set buyingCount confidence to 0.6 if the description is ambiguous about the count`
          }]
        },
        contents: [{
          parts: [{
            text: `Here is the description of the poker sheet:\n\n${description}\n\nConvert this into the required JSON.`
          }]
        }]
      })
    })

    const parseData = await parseResp.json()
    const text = parseData.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text || '').join('') ?? ''
    const clean = text.replace(/```json|```/g, '').trim()
    const result = JSON.parse(clean)

    return NextResponse.json(result)
  } catch (err) {
    console.error('OCR error:', err)
    return NextResponse.json({ error: 'OCR failed', detail: String(err) }, { status: 500 })
  }
}
