require('dotenv').config();
const express = require('express');
const axios = require('axios');
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const moment = require('moment');
const FormData = require('form-data');
const { MongoClient } = require('mongodb');

// MongoDB setup
const client = new MongoClient(process.env.MONGODB_URI);
let db;

async function connectToMongoDB() {
    try {
        await client.connect();
        db = client.db();
        console.log("Connected to MongoDB");
    } catch (error) {
        console.error("Could not connect to MongoDB:", error);
    }
}
class QueryModel {
    constructor(data) {
        this.discorduser = data.discorduser || null;
        this.searchParameters = data.searchParameters || {};
        this.sentItemIds = data.sentItemIds || [];
        this.itemType = data.itemType || [];
        this.classes = data.classes || [];
        this.powerLevelMin = data.powerLevelMin || 0;
        this.powerLevelMax = data.powerLevelMax || 1000;
        this.affixes = data.affixes || [];
        this.limit = data.limit || 20;
        this.payloadUri = data.payloadUri || '';
        this.lastRun = data.lastRun || null;
        this.lastItemTimestamp = data.lastItemTimestamp || null;
        this.isRecurring = data.isRecurring || false; // New field to indicate if the query is recurring
        this.recurringInterval = data.recurringInterval || 'daily'; // Example: 'daily', 'weekly', etc.
    }

    async save() {
        if (!db) {
            await connectToMongoDB();
        }
        const collection = db.collection('queries');
        return collection.insertOne(this);
    }
}

const cron = require('node-cron');

function scheduleRecurringJobs() {
    // Fetch only recurring queries
    db.collection('queries').find({ isRecurring: true }).toArray((err, queries) => {
        if (err) {
            console.error('Failed to fetch recurring queries:', err);
            return;
        }

        queries.forEach(query => {
            // Set up cron jobs based on the recurringInterval
            const cronExpression = convertIntervalToCron(query.recurringInterval);
            cron.schedule(cronExpression, async () => {
                const items = await fetchItems(query.itemType, query.affixes.map(affix => affix.id));
                // Further processing...
            });
        });
    });
}

function convertIntervalToCron(interval) {
    switch (interval) {
        case 'daily':
            return '0 0 * * *'; // Every day at midnight
        case 'weekly':
            return '0 0 * * 0'; // Every Sunday at midnight
        default:
            return '0 0 * * *'; // Default to daily if undefined
    }
}

const app = express();
app.use(express.static('public'));
app.use(express.json());

app.post('/construct-url', async (req, res) => {
    try {
        const { itemType, effectsGroup, discordUserID } = req.body.formData; // Assuming formData is directly in the body

        console.log("Discord User ID received:", discordUserID);  // Verify the ID is being received correctly

        const affixIdentifiers = effectsGroup.map(group => group.effectId);
        const items = await fetchItems(itemType, affixIdentifiers);

        const batchSize = 10;
        for (let i = 0; i < items.length; i += batchSize) {
            const currentBatch = items.slice(i, i + batchSize);

        for (const item of currentBatch) {
            const imagePath = await takeScreenshot(item._id);
            if (!imagePath) {
                console.error('Failed to capture screenshot for item ID:', item._id);
                continue; // Skip this item if screenshot failed
            }

            const listingAge = Date.now() - new Date(item.updatedAt);
            const embed = constructEmbed(item, imagePath, listingAge);

            const message = {
                content: discordUserID ? `<@${discordUserID}> Check out this new listing!` : "Check out this new listing!",  // Mention user if ID is provided
                embeds: [embed],
                files: [imagePath]
            };

            await sendToDiscord(message);
            fs.unlinkSync(imagePath);  // Clean up the screenshot file after sending
        }

        await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        res.json({ message: 'Processed all items successfully.' });
    } catch (error) {
        console.error('Failed to process items:', error);
        res.status(500).json({ error: error.message });
    }
});


async function fetchItems(itemType, affixIdentifiers) {
    const apiUrl = constructApiUrl(itemType, affixIdentifiers);
    const response = await axios.get(apiUrl);
    return response.data[0].result.data.json.data;
}

function constructApiUrl(itemType, affixIdentifiers) {
    const baseUrl = 'https://diablo.trade/api/trpc/offer.search';
    const effects = affixIdentifiers.map(id => ({
        id: id,
        value: { min: null, max: null }
    }));

    const inputPayload = {
        "0": {
            "json": {
                "mode": ["season softcore"],
                "itemType": itemType,
                "class": [],
                "sockets": [],
                "category": [],
                "price": { "min": 0, "max": 9999999999 },
                "powerLevel": [0, 1000],
                "levelRequired": [0, 100],
                "sort": { "updatedAt": -1, "createdAt": -1 },
                "sold": false,
                "exactPrice": false,
                "cursor": 1,
                "limit": 20,
                "effectsGroup": [{
                    "type": "and",
                    "effects": effects,
                    "value": null,
                    "effectType": "affixes"
                }]
            },
            "meta": {
                "values": {
                    "effectsGroup.0.effects.0.value.min": ["undefined"],
                    "effectsGroup.0.effects.0.value.max": ["undefined"],
                    "effectsGroup.0.value": ["undefined"]
                }
            }
        }
    };
    const inputParam = encodeURIComponent(JSON.stringify(inputPayload));
    return `${baseUrl}?batch=1&input=${inputParam}`;
}


async function takeScreenshot(id) {
    const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    const url = `https://diablo.trade/listings/items/${id}`;
    await page.goto(url, { waitUntil: 'networkidle0' });
    const imagePath = path.join(__dirname, `${id}.png`);
    const element = await page.$('.relative.mx-auto.h-fit.w-64.border-\\[20px\\].sm\\:w-72.sm\\:border-\\[24px\\].flip-card-face');
    await element.screenshot({ path: imagePath });
    await browser.close();
    return imagePath;
}

function constructEmbed(item, imagePath, listingAge) {
    return {
        title: item.userId.name || 'Unknown Seller',
        description: '**Click on the btag to view listing**',
        url: `https://diablo.trade/listings/items/${item._id}`,
        color: 0x0099ff,
        fields: [
            { name: 'Price', value: `${item.price / 1000000} Million(s)`, inline: true },
            { name: 'Listing Age', value: moment.duration(listingAge).humanize(), inline: true }
        ],
        image: { url: 'attachment://' + path.basename(imagePath) },
        timestamp: new Date(item.updatedAt).toISOString(),
        footer: { text: 'Diablo.trade' }
    };
}

async function sendToDiscord({ content, embeds, files }) {
    const formData = new FormData();
    formData.append('payload_json', JSON.stringify({ content, embeds }));

    // Ensure 'files' is actually an array
    if (Array.isArray(files)) {
        files.forEach(file => {
            formData.append('file', fs.createReadStream(file), { filename: path.basename(file) });
        });
    } else {
        console.error('Expected files to be an array, but received:', files);
        return; // Optionally return an error or throw here
    }

    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    try {
        const response = await axios.post(webhookUrl, formData, {
            headers: formData.getHeaders()
        });
        console.log('Message sent successfully:', response.data);
    } catch (error) {
        console.error('Failed to send message to Discord:', error);
    }
}

app.listen(3000, () => console.log('Server running on port 3000'));
