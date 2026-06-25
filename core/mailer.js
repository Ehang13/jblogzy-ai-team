import 'dotenv/config';
import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST   || 'smtp-relay.brevo.com',
  port:   Number(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const FROM_NAME  = process.env.EMAIL_FROM_NAME || 'jblogzy 팀';
const FROM_EMAIL = process.env.EMAIL_FROM      || process.env.SMTP_USER;

export async function sendMail({ to, subject, html, text }) {
  const info = await transporter.sendMail({
    from: `"${FROM_NAME}" <${FROM_EMAIL}>`,
    to,
    subject,
    html:  html  || `<pre>${text}</pre>`,
    text:  text  || '',
  });
  console.log(`[mailer] ✅ 발송 완료 → ${to}`);
  return info;
}

export async function verifyConnection() {
  await transporter.verify();
  console.log('[mailer] ✅ SMTP 연결 정상');
}
