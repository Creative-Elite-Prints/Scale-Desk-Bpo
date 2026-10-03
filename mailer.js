// Sends email through Resend's web API. Set EMAIL_API_KEY and EMAIL_FROM (a sender you have verified) to turn it on.
const KEY = process.env.EMAIL_API_KEY || '';
const FROM = process.env.EMAIL_FROM || '';
const URL_ = process.env.EMAIL_API_URL || 'https://api.resend.com/emails';

exports.enabled = () => !!(KEY && FROM);

exports.send = async ({ to, subject, text, replyTo }) => {
  if (!exports.enabled()) throw new Error('Email is not set up');
  const r = await fetch(URL_, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to: [to], subject, text, reply_to: replyTo || undefined }),
    signal: AbortSignal.timeout(15000)
  });
  if (!r.ok) throw new Error('Email service returned ' + r.status);
};
