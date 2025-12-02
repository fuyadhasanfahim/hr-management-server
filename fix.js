const { MongoClient } = require('mongodb');

// ✅ CHANGE THESE
const MONGO_URI =
    'mongodb+srv://asad4design:xKlLtOGNskl3JLuT@cluster0.ctrun.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0'; // or your Atlas URL
const DB_NAME = 'hrManagement';
const COLLECTION_NAME = 'localOrderList';

// ✅ Safe date parser for ALL your formats
function safeParseDate(value) {
    if (!value) return null;

    // Already a Date object
    if (value instanceof Date) return value;

    if (typeof value !== 'string') return null;

    let d = null;

    // Case 1: "19-Nov-2025"
    if (/^\d{2}-[A-Za-z]{3}-\d{4}$/.test(value)) {
        d = new Date(value.replace(/-/g, ' '));
    }

    // Case 2: "20-Nov-2025 00:00:00"
    else if (/^\d{2}-[A-Za-z]{3}-\d{4}/.test(value)) {
        d = new Date(value);
    }

    // Case 3: "Wed Nov 19 2025 00:00:00 GMT+0600..."
    else {
        d = new Date(value);
    }

    return isNaN(d.getTime()) ? null : d;
}

async function migrateDates() {
    const client = new MongoClient(MONGO_URI);

    try {
        await client.connect();
        console.log('✅ Connected to MongoDB');

        const db = client.db(DB_NAME);
        const collection = db.collection(COLLECTION_NAME);

        const cursor = collection.find({});
        let updated = 0;
        let failed = 0;

        while (await cursor.hasNext()) {
            const doc = await cursor.next();

            const newDate = safeParseDate(doc.date);
            const newDeadline = safeParseDate(doc.orderDeadLine);

            if (newDate || newDeadline) {
                await collection.updateOne(
                    { _id: doc._id },
                    {
                        $set: {
                            ...(newDate && { date: newDate }),
                            ...(newDeadline && { orderDeadLine: newDeadline }),
                        },
                    }
                );
                updated++;
            } else {
                failed++;
                console.log(
                    '❌ Failed to parse:',
                    doc._id,
                    doc.date,
                    doc.orderDeadLine
                );
            }
        }

        console.log('✅ Migration completed');
        console.log('✅ Updated:', updated);
        console.log('❌ Failed:', failed);
    } catch (err) {
        console.error('🔥 Migration error:', err);
    } finally {
        await client.close();
        console.log('✅ MongoDB connection closed');
    }
}

migrateDates();
