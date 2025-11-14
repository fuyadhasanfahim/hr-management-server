const cloudinary = require('./cloudinary');
const streamifier = require('streamifier');

exports.uploadToCloudinary = (fileBuffer, folder = 'employee_profiles') => {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            {
                folder,
                resource_type: 'image',
                transformation: [
                    { width: 150, height: 150, crop: 'fill', gravity: 'face' }, // Resize to 300x300, crop to fit face
                    { quality: 'auto' }, // Automatically optimize quality
                    { fetch_format: 'auto' } // Automatically convert to best format (e.g., WebP)
                ]
            },
            (error, result) => {
                if (result) resolve(result.secure_url);
                else reject(error);
            }
        );
        streamifier.createReadStream(fileBuffer).pipe(stream);
    });
};

