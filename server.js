const express = require('express');
const axios = require('axios');
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const moment = require('moment');
const FormData = require('form-data');
const { MongoClient } = require('mongodb');
const cron = require('node-cron');

require('dotenv').config();

const app = express();
app.use(express.static('public'));
app.use(express.json());

const logFilePath = path.join(__dirname, 'server.log');

function logToFile(message, data = null, isError = false) {
    const timestamp = new Date().toISOString();
    let logMessage = `${timestamp} - ${isError ? 'ERROR' : 'INFO'} - ${message}`;

    if (data) {
        const simpleData = {
            statusCode: data.status || 'No status', // Use default if status is not available
        };

        // Check if data is available and has a data property before accessing length
        if (data.data && typeof data.data === 'object') {
            simpleData.contentLength = JSON.stringify(data.data).length; // Stringify if object to get length
        } else if (typeof data.data === 'string') {
            simpleData.contentLength = data.data.length; // Directly access length if string
        } else {
            simpleData.contentDetail = 'No detailed data available'; // Default message if data is not structured as expected
        }

        logMessage += ` - ${JSON.stringify(simpleData)}`;
    }

    // Append to the log file
    fs.appendFile(logFilePath, logMessage + '\n', (err) => {
        if (err) {
            console.error('Failed to write to log file:', err);
        }
    });

    // Additionally log errors to the console
    if (isError) {
        console.error(logMessage);
    }
}

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

async function loadScheduledJobs() {
    try {
        const collection = db.collection('cronJobs');
        const jobs = await collection.find({}).toArray(); // Using toArray() with async/await
        if (jobs.length === 0) {
            console.log('No scheduled jobs found in database.');
        }
        jobs.forEach(job => {
            console.log(`Loading job ID ${job.jobId} with schedule ${job.schedule}`);
            cronManager.addJob(job.jobId, job.schedule, () => executeQuery(job.details), job.details);
        });
    } catch (error) {
        console.error('Failed to load scheduled jobs:', error);
    }
}

connectToMongoDB();

function executeQuery(query) {
    console.log(`Executing query for ${query.itemType}`);
    // Your function to execute queries goes here
}

// Your express routes for handling API requests
app.post('/add-cron-job', async (req, res) => {
    const { id, schedule, query, } = req.body;
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
    const { id, schedule, query } = req.body.formData;
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
        const { itemType, effectsGroup, discordUserID, recurringJob } = req.body.formData;

        console.log("Discord User ID received:", discordUserID);
        console.log("Recurring job:", recurringJob);

        const affixIdentifiers = effectsGroup.map(group => group.effectId);
        const items = await fetchItems(itemType, affixIdentifiers);

        const batchSize = 10;  // Define the number of embeds per batch
        const embedsToSend = [];  // Initialize an array to hold embeds for batch sending

        for (const item of items) {
            let imagePath = await takeScreenshot(item._id);
            if (!imagePath) {
                console.error(`Failed to capture screenshot for item ID ${item._id}`);
                continue;
            }

            const listingAge = Date.now() - new Date(item.updatedAt);
            const embed = constructEmbed(item, imagePath, listingAge);
            embedsToSend.push(embed);

            if (embedsToSend.length === batchSize || items.indexOf(item) === items.length - 1) {
                await sendToDiscord({ content: `<@${discordUserID}> Check out these new listings!`, embeds: embedsToSend });
                embedsToSend.length = 0; // Clear the array after sending
            }

            fs.unlinkSync(imagePath); // Clean up the screenshot file
        }

        // Send any remaining embeds
        if (embedsToSend.length > 0) {
            await sendToDiscord({ content: `<@${discordUserID}> Check out these new listings!`, embeds: embedsToSend });
        }

        if (recurringJob) {
            console.log('Setting up recurring job...');
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
    const url = `https://diablo.trade/listings/items/${id}`;
    const imagePath = path.join(__dirname, `${id}.png`);
    const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });

    try {
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 }); // Increased timeout to 60 seconds
        const element = await page.$('.relative.mx-auto.h-fit.w-64.border-\\[20px\\].sm\\:w-72.sm\\:border-\\[24px\\].flip-card-face');

        if (element) {
            await element.screenshot({ path: imagePath });
        } else {
            throw new Error("Screenshot target element not found.");
        }
    } catch (error) {
        console.error(`Failed to capture screenshot for item ID ${id}:`, error);
        return null; // Return null to indicate a failure
    } finally {
        await browser.close();
    }

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

async function sendToDiscord({ content, embeds }) {
    const formData = new FormData();
    formData.append('payload_json', JSON.stringify({ content, embeds }));

    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    try {
        const response = await axios.post(webhookUrl, formData, {
            headers: formData.getHeaders()
        });
        logToFile('Messages sent successfully', response, false); // Log success with response data
    } catch (error) {
        logToFile('Failed to send messages to Discord', error, true); // Log error with error details
    }
}

app.listen(3000, () => console.log('Server running on port 3000'));
