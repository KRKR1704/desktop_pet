// Google Gemini adapter — uses gemini-2.5-flash-image (a multimodal chat
// model, "Nano Banana"), not the separate Imagen `predict` endpoint. Imagen
// 3's public Gemini API surface is text-to-image only (no reference-image
// input), so it can't take the user's uploaded photo; gemini-2.5-flash-image
// natively accepts an inline image part alongside the text prompt and edits/
// restyles it, which is what this needs for the same photo-consistency
// reason described in backend/providers/openai.js.
//
// Endpoint/request shape verified 2026-07 directly against a working curl
// example for this exact model+use-case (inline_data + text parts to
// generateContent, x-goog-api-key header) — the response shape
// (candidates[].content.parts[].inlineData) matches Gemini's standard
// generateContent contract used across the rest of the API.
//
// `seed` (from backend/forge.js's one-per-session value) is passed via
// generationConfig, the same top-level config object documented for every
// other generateContent knob (temperature, topK, topP, etc) — confirmed as
// a real field on GenerationConfig, but NOT confirmed live specifically for
// image-output determinism: Gemini's own docs describe it generally as
// "control reproducibility of outputs" without a separate carve-out for
// image tokens, and this adapter has no live-keyed way to check whether
// that holds for images the same way it does for text. Sending it is a
// best-effort, low-risk addition either way (harmless no-op if it isn't
// honored for image output — this provider still gets the real consistency
// win from the anchor-frame reference image itself and the identity-lock
// prompt text, same as the other two providers).
'use strict';

const { ForgeError, classifyHttpError } = require('../forgeError');

const MODEL = 'gemini-2.5-flash-image';
const GENERATE_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

async function generateFrame({ referencePhoto, prompt, apiKey, seed }) {
  const body = {
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: referencePhoto.mimeType, data: referencePhoto.buffer.toString('base64') } }
      ]
    }]
  };
  if (Number.isFinite(seed)) body.generationConfig = { seed };

  let res;
  try {
    res = await fetch(GENERATE_URL, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (err) {
    throw new ForgeError('network', `Could not reach Gemini (${err.message}).`, { cause: err });
  }

  const bodyText = await res.text();
  if (!res.ok) {
    throw new ForgeError(classifyHttpError(res.status, bodyText), `Gemini returned ${res.status}: ${bodyText.slice(0, 300)}`);
  }

  let json;
  try {
    json = JSON.parse(bodyText);
  } catch (err) {
    throw new ForgeError('unknown', `Gemini response was not valid JSON: ${err.message}`);
  }

  if (json.promptFeedback && json.promptFeedback.blockReason) {
    throw new ForgeError('content_policy', `Gemini blocked the request (${json.promptFeedback.blockReason}).`);
  }

  const candidate = json.candidates && json.candidates[0];
  if (candidate && candidate.finishReason === 'SAFETY') {
    throw new ForgeError('content_policy', 'Gemini blocked the response for safety reasons.');
  }

  const parts = (candidate && candidate.content && candidate.content.parts) || [];
  const imagePart = parts.find((p) => p.inlineData || p.inline_data);
  const inline = imagePart && (imagePart.inlineData || imagePart.inline_data);
  if (!inline || !inline.data) {
    throw new ForgeError('unknown', 'Gemini response had no image data.');
  }

  return { buffer: Buffer.from(inline.data, 'base64'), mimeType: inline.mimeType || inline.mime_type || 'image/png' };
}

module.exports = {
  id: 'gemini',
  label: 'Google Gemini',
  keyPlaceholder: 'AIza••••••••••••••••',
  keyHelpUrl: 'https://aistudio.google.com/apikey',
  costNote: 'gemini-2.5-flash-image is billed per output image (~$0.039/image at current list pricing) — this forges 36 images per character.',
  generateFrame
};
