const mongoose = require('mongoose');

const SportSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true, index: true },  // 'soccer_epl'
    group: { type: String, required: true },                            // 'Soccer'
    title: { type: String, required: true },                            // 'EPL'
    description: { type: String, default: '' },
    active: { type: Boolean, default: true },
    hasOutrights: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model('Sport', SportSchema);
