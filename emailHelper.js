// emailHelper.js
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

const OUTLOOK_USER = process.env.OUTLOOK_USER;
const OUTLOOK_PASS = process.env.OUTLOOK_PASS;
const OUTLOOK_FROM = process.env.OUTLOOK_FROM || OUTLOOK_USER || 'ZFL ClaimEase <no-reply@example.com>';

// Setup transporter for Outlook / Office365
const transporter = nodemailer.createTransport({
  host: 'smtp.office365.com',
  port: 587,
  secure: false, // STARTTLS
  auth: {
    user: OUTLOOK_USER,
    pass: OUTLOOK_PASS
  },
  tls: {
    ciphers: 'TLSv1.2'
  }
});

/**
 * Templates mapping for stages
 * stage: one of 'received', 'manager', 'hr', 'finance'
 */
const templates = {
  received: {
    subject: 'Invoice Received – Acknowledgement',
    html: (uniqueNumber) => `
      <p>Dear Sender,</p>

      <p>Thank you for your email.</p>

      <p>
        This is an automated acknowledgement to confirm that your invoice has been
        successfully received by our system. Our HR/Finance team will review the submitted
        invoice and process it as per the standard timeline.
      </p>

      <p>
        If any additional documents or information are required, our team will reach out to you.
        <br/><strong>Please do not reply to this email, as this mailbox is for invoice submissions only.</strong>
      </p>

      <p>Thank you for your cooperation.</p>

      <p>
        Warm regards,<br/>
        <strong>ZFL ClaimEase</strong><br/>
        
      </p>

      <p><em>Attachment:</em> Invoice Details – ${uniqueNumber}.pdf</p>
    `
  },

  manager: {
    subject: 'Invoice Update – Approved by Manager',
    html: (uniqueNumber) => `
      <p>Dear Sender,</p>

      <p>
        We would like to inform you that your invoice has been <strong>approved by the Manager</strong>.
      </p>

      <p>
        Our team will now proceed with the next steps as per the internal process.
        If any additional information or documents are required, we will reach out to you.
      </p>

      <p>Thank you for your cooperation.</p>

      <p>
        Warm regards,<br/>
        <strong>ZFL ClaimEase</strong><br/>
        
      </p>

      <p><em>Attachment:</em> Invoice Details – ${uniqueNumber}.pdf</p>
    `
  },

  hr: {
    subject: 'Invoice Update – Approved by HR Department',
    html: (uniqueNumber) => `
      <p>Dear Sender,</p>

      <p>
        We would like to inform you that your invoice has been
        <strong>approved by the HR Department</strong>.
      </p>

      <p>
        Our team will now proceed with the next steps as per the internal process.
        If any additional information or documents are required, we will reach out to you.
      </p>

      <p>Thank you for your cooperation.</p>

      <p>
        Warm regards,<br/>
        <strong>ZFL ClaimEase</strong><br/>
        
      </p>

      <p><em>Attachment:</em> Invoice Details – ${uniqueNumber}.pdf</p>
    `
  },

  finance: {
    subject: 'Invoice Update – Approved by Finance Department',
    html: (uniqueNumber) => `
      <p>Dear Sender,</p>

      <p>
        We would like to inform you that your invoice has been
        <strong>approved by the Finance Department</strong>.
      </p>

      <p>
        Our team will now proceed with the next steps as per the internal process.
        If any additional information or documents are required, we will reach out to you.
      </p>

      <p>Thank you for your cooperation.</p>

      <p>
        Warm regards,<br/>
        <strong>ZFL ClaimEase</strong><br/>
        
      </p>

      <p><em>Attachment:</em> Invoice Details – ${uniqueNumber}.pdf</p>
    `
  }
};

/**
 * sendApprovalEmail
 * @param {string} stage - 'received' | 'manager' | 'hr' | 'finance'
 * @param {string} toEmail - recipient email
 * @param {string} uniqueNumber - invoice/unique id (used in subject and attachment name)
 * @param {Object} [opts] - optional: {pdfPath, cc, bcc, extraReplacements}
 */
async function sendApprovalEmail(stage, toEmail, uniqueNumber, opts = {}) {
  if (!templates[stage]) throw new Error('Unknown email stage: ' + stage);
  if (!toEmail) throw new Error('toEmail required');

  const tpl = templates[stage];

  // default pdf path (change if you store elsewhere)
  const pdfDefaultPath = path.join(__dirname, 'uploads', `${uniqueNumber}.pdf`);
  const pdfPath = opts.pdfPath || pdfDefaultPath;

  // build mail
  const mailOptions = {
    from: OUTLOOK_FROM,
    to: toEmail,
    subject: tpl.subject,
    text: (tpl.html(uniqueNumber).replace(/<\/?[^>]+(>|$)/g, "")), // plain text fallback
    html: tpl.html(uniqueNumber),
    cc: opts.cc,
    bcc: opts.bcc,
    attachments: []
  };

  // attach PDF if present
  try {
    if (pdfPath && fs.existsSync(pdfPath)) {
      mailOptions.attachments.push({
        filename: `Invoice Details - ${uniqueNumber}.pdf`,
        path: pdfPath,
        contentType: 'application/pdf'
      });
    } else if (opts.pdfUrl) {
      // Attach by URL if provided (nodemailer supports it as a stream if you fetch it)
      // easiest: attach via link in the email body instead of attachment when PDF not local.
      mailOptions.html += `<p>PDF: <a href="${opts.pdfUrl}">Download Invoice PDF</a></p>`;
      mailOptions.text += `\nPDF: ${opts.pdfUrl}`;
    } else {
      // No local PDF — add a note in the body
      mailOptions.html += `<p><em>Note: PDF attachment not found on server.</em></p>`;
      mailOptions.text += `\nNote: PDF attachment not found on server.`;
    }
  } catch (err) {
    // ignore attachment errors, send email anyway with a note
    mailOptions.html += `<p><em>Note: Error attaching PDF: ${String(err)}</em></p>`;
    mailOptions.text += `\nNote: Error attaching PDF: ${String(err)}`;
  }

  // send email
  const info = await transporter.sendMail(mailOptions);
  return info;
}

module.exports = { sendApprovalEmail };
