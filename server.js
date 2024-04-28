require('dotenv').config();
const express = require('express');
const axios = require('axios');
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const moment = require('moment');
const FormData = require('form-data');
const { MongoClient } = require('mongodb');
const cron = require('node-cron');

const app = express();
app.use(express.static('public'));
app.use(express.json());

class CronManager {
    constructor() {
        this.jobs = new Map();
    }

    addJob(id, schedule, taskFunction, queryDetails) {
        if (this.jobs.has(id)) {
            console.log(`Job ID ${id} is already running. Please stop it before adding a new one.`);
            return;
        }
        const job = cron.schedule(schedule, taskFunction, { scheduled: false });
        this.jobs.set(id, job);
        job.start();
        console.log(`Job ID ${id} added and started.`);

        const collection = db.collection('cronJobs');
        collection.updateOne({ jobId: id }, { $set: { schedule: schedule, details: queryDetails } }, { upsert: true });
    }

    removeJob(id) {
        if (this.jobs.has(id)) {
            const job = this.jobs.get(id);
            job.stop();
            job.destroy();
            this.jobs.delete(id);
            console.log(`Job ID ${id} stopped and removed.`);

            const collection = db.collection('cronJobs');
            collection.deleteOne({ jobId: id });
        } else {
            console.log(`Job ID ${id} not found.`);
        }
    }

    updateJob(id, newSchedule, taskFunction, queryDetails) {
        this.removeJob(id);
        this.addJob(id, newSchedule, taskFunction, queryDetails);
    }
}

const cronManager = new CronManager();

// MongoDB setup
const client = new MongoClient(process.env.MONGODB_URI);
let db;

async function connectToMongoDB() {
    try {
        await client.connect();
        db = client.db("yourDatabase");
        console.log("Connected to MongoDB");
        loadScheduledJobs();  // Ensure jobs are loaded after DB connection
    } catch (error) {
        console.error("Could not connect to MongoDB:", error);
    }
}

function loadScheduledJobs() {
    const collection = db.collection('cronJobs');
    collection.find({}).forEach(job => {
        cronManager.addJob(job.jobId, job.schedule, () => executeQuery(job.details), job.details);
    });
}

connectToMongoDB();

function executeQuery(query) {
    console.log(`Executing query for ${query.itemType}`);
    // Your function to execute queries goes here
}

// Your express routes for handling API requests
app.post('/add-cron-job', async (req, res) => {
    const { id, schedule, query } = req.body;
    cronManager.addJob(id, schedule, () => executeQuery(query), query);
    res.send({ message: `Cron job ${id} added and started.` });
});

app.post('/remove-cron-job', (req, res) => {
    const { id } = req.body;
    cronManager.removeJob(id);
    res.send({ message: `Cron job ${id} removed.` });
});

app.post('/update-cron-job', (req, res) => {
    const { id, newSchedule, query } = req.body;
    cronManager.updateJob(id, newSchedule, () => executeQuery(query), query);
    res.send({ message: `Cron job ${id} updated.` });
});

app.get('/list-cron-jobs', (req, res) => {
    const jobs = Array.from(cronManager.jobs).map(([id, job]) => ({
        id: id,
        schedule: job.nextDates().toString()
    }));
    res.json(jobs);
});

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

function scheduleRecurringJobs() {
    // Fetch only recurring queries
    db.collection('queries').find({ isRecurring: true }).toArray((err, queries) => {
        if (err) {
            console.error('Failed to fetch recurring queries:', err);
            return;
        }

        queries.forEach(query => {
            const jobId = `query-${query._id}`; // Unique ID for each job
            const cronExpression = convertIntervalToCron(query.recurringInterval);

            // Check if job already exists, if so, update it, otherwise add new
            if (cronManager.jobs.has(jobId)) {
                cronManager.updateJob(jobId, cronExpression, () => executeQuery(query));
            } else {
                cronManager.addJob(jobId, cronExpression, () => executeQuery(query));
            }
        });
    });
}

// Endpoint to add a new cron job
app.post('/add-cron-job', async (req, res) => {
    const { id, schedule, query } = req.body;
    cronManager.addJob(id, schedule, () => executeQuery(query));
    res.send({ message: `Cron job ${id} added and started.` });
});

// Endpoint to remove a cron job
app.post('/remove-cron-job', (req, res) => {
    const { id } = req.body;
    cronManager.removeJob(id);
    res.send({ message: `Cron job ${id} removed.` });
});

// Endpoint to update a cron job
app.post('/update-cron-job', (req, res) => {
    const { id, newSchedule } = req.body;
    cronManager.updateJob(id, newSchedule);
    res.send({ message: `Cron job ${id} updated.` });
});

// Endpoint to list all cron jobs
app.get('/list-cron-jobs', (req, res) => {
    const jobs = Array.from(cronManager.jobs).map(([id, job]) => {
        console.log(`Job ID: ${id}, Schedule: ${job.nextDates().toString()}`); // Log each job
        return { id: id, schedule: job.nextDates().toString() };
    });
    res.json(jobs);
});

function executeQuery(query) {
    console.log(`Executing query for ${query.itemType}`);
    // your fetchItems function or similar could be called here
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
    const effects = affixIdentifiers.map(id => {
        // Prepare object conditionally based on your app's logic or input
        const effect = { id: id };

        // Optionally add min/max if available and valid
        effect.value = {};
        if (typeof someMinValue === 'number') effect.value.min = someMinValue; // Replace 'someMinValue' with actual logic to obtain value
        if (typeof someMaxValue === 'number') effect.value.max = someMaxValue; // Replace 'someMaxValue' with actual logic to obtain value

        // Remove value object if empty
        if (Object.keys(effect.value).length === 0) delete effect.value;

        return effect;
    });

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
