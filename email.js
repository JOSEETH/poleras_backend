const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);

async function sendStoreNotificationEmail({ to, subject, html }) {
  if (!process.env.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY not configured");
  }

  const from =
    process.env.EMAIL_FROM || "Huillinco <onboarding@resend.dev>";

  return resend.emails.send({
    from,
    to,
    subject,
    html,
  });
}

module.exports = {
  sendStoreNotificationEmail,
};
