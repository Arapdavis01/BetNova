const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD
    }
});

async function sendOtpEmail(toEmail, code) {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
        throw new Error('Email service not configured.');
    }

    const mailOptions = {
        from: `"BetNova" <${process.env.EMAIL_USER}>`,
        to: toEmail,
        subject: 'Your BetNova Verification Code',
        html: `
            <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
                <h2 style="color: #ef4444;">BetNova Verification</h2>
                <p>Your verification code is:</p>
                <h1 style="font-size: 36px; letter-spacing: 8px; color: #10b981; background: #0f1420; padding: 16px; text-align: center; border-radius: 8px;">
                    ${code}
                </h1>
                <p style="color: #64748b; font-size: 14px;">This code expires in 5 minutes.</p>
                <p style="color: #64748b; font-size: 12px;">If you did not request this, ignore this email.</p>
            </div>
        `
    };

    const info = await transporter.sendMail(mailOptions);
    console.log('OTP email sent:', info.messageId);
    return { success: true, messageId: info.messageId };
}

module.exports = { sendOtpEmail };
