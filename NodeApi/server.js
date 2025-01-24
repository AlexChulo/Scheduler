const express = require('express');
const session = require('express-session');
const mysql = require('mysql2');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const cors = require('cors');
const WebSocket = require('ws'); // WebSocket-client
const multer = require('multer'); // File upload

const port = process.env.PORT || 3000;

// Maak een verbinding met de MySQL-database
const db = mysql.createConnection({
    host: 'localhost', // Database
    user: 'root', // Darabase gebruikersnaam
    password: '', // Databas wachrwoord
    database: 'printer' // Database naam
});

// Test de verbinding
db.connect(err => {
    if (err) {
        console.error('Kan niet verbinden met MySQL:', err);
        return;
    }
    console.log('Verbonden met MySQL');
});

// Maak de Express-applicatie
const app = express();
app.use(express.json());
app.use(cors({
    origin: 'http://localhost',
    credentials: true
}));

app.use(session({
    secret: 'your-secret-key', // Change this to a secure key
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: false, // Set to true if using HTTPS
        httpOnly: true, // Prevent client-side JavaScript from accessing the cookie
        maxAge: 1000 * 60 * 60 * 24 // Session expiration time (1 day)
    }
}));

// File upload configuration
const storage = multer.memoryStorage(); // Store files in memory
const upload = multer({ storage });

// Middleware to check if the user is logged in
const requireLogin = (req, res, next) => {
    if (!req.session.user) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
};
// ------------------ Test API ------------------ //

// Test API-endpoint
app.get('/api/test', (req, res) => {
    // Controleer de verbinding met de database
    db.ping((err) => {
        if (err) {
            console.error('Database verbinding mislukt:', err);
            return res.status(500).json({ message: 'Database verbinding mislukt.', error: err });
        }
        res.status(200).json({ message: 'Server en database werken correct!' });
    });
});

// ------------------ Login API ------------------ //

// Login endpoint
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;

    // Fetch user from the database
    const query = 'SELECT * FROM users WHERE username = ? AND password = ?';
    db.query(query, [username, password], (err, results) => {
        if (err) {
            console.error('Error during login:', err);
            return res.status(500).json({ error: 'Could not log in' });
        }

        if (results.length === 0) {
            return res.status(401).json({ error: 'Invalid username or password' });
        }

        const user = results[0];

        // Store user in session
        req.session.user = { id: user.id, username: user.username };
        console.log('Session created:', req.session); // Log the session data

        res.status(200).json({ message: 'Login successful', user: req.session.user });
    });
});
// Logout endpoint
app.post('/api/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error('Error during logout:', err);
            return res.status(500).json({ error: 'Could not log out' });
        }
        res.status(200).json({ message: 'Logout successful' });
    });
});



// ------------------ Registreer API ------------------ //

// Register API-endpoint
app.post('/api/register', (req, res) => {
    const { username, email, phone, password } = req.body;

    // Voeg de gebruiker toe aan de database
    const query = 'INSERT INTO user (username, email, phone, password) VALUES (?, ?, ?, ?)';
    db.query(query, [username, email, phone, password], (err, results) => {
        if (err) {
            console.error('Error tijdens registreren:', err);
            return res.status(500).json({ error: 'Kan niet registreren' });
        }

        res.status(200).json({ message: 'Registratie gelukt' });
    });
});



// ------------------ Filament API ------------------ //

// Filament waarde API-endpoint
app.get('/api/filament', (req, res) => {
    const query = 'SELECT totalGram FROM filament';
    db.query(query, (err, results) => {
        if (err) {
            console.error('Error tijdens het ophalen van filamentwaarde:', err);
            return res.status(500).json({ error: 'Kan filamentwaarde niet ophalen' });
        }

        if (results.length === 0 || results[0].totalGram === null) {
            return res.status(404).json({ error: 'Geen filamentwaarde gevonden' });
        }

        const totalFilamentGrams = results[0].totalGram;
        const totalFilamentKg = totalFilamentGrams / 1000;
        const rolls = Math.round(totalFilamentKg / 1.1);

        res.status(200).json({ rolls });
    });
});

// Filament toevoegen/verwijderen API-endpoint
app.post('/api/update-filament', (req, res) => {
    const { amount } = req.body;

    const query = 'UPDATE filament SET totalGram = totalGram + ?';
    db.query(query, [amount], (err, results) => {
        if (err) {
            console.error('Error tijdens het bijwerken van filamentwaarde:', err);
            return res.status(500).json({ error: 'Kan filamentwaarde niet bijwerken' });
        }

        res.status(200).json({ message: 'Filamentwaarde bijgewerkt' });
    });
});

// ------------------ Printer API ------------------ //

// Get printer data API-endpoint
app.get('/api/printers', (req, res) => {
    const query = `
        SELECT id, name, speed, weight_capacity, max_width, max_height, max_depth
        FROM printers
    `;
    
    db.query(query, (err, results) => {
        if (err) {
            console.error('Error during fetching printer data:', err);
            return res.status(500).json({ error: 'Could not fetch printer data' });
        }

        if (results.length === 0) {
            return res.status(404).json({ error: 'No printers found' });
        }

        res.status(200).json(results); // Send printers data as JSON
    });
});

// Submit a Print Job (Initial Submission)
app.post('/api/print_jobs', upload.single('file'), (req, res) => {
    // Check if the user is logged in
    if (!req.session.user) {
        return res.status(401).json({ error: 'Unauthorized: Please log in' });
    }

    const userId = req.session.user.id; // Get the user ID from the session

    console.log('Request body:', req.body); // Log the request body
    console.log('Uploaded file:', req.file); // Log the uploaded file

    const {
        subject,
        private,
        discussed,
        description,
        weight,
        length,
        width,
        height
    } = req.body;

    const fileData = req.file.buffer; // Binary data of the uploaded file
    const fileName = req.file.originalname; // Original file name

    // Validate required fields
    if (!subject || !fileData || !weight || !length || !width || !height) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    // SQL query to insert the print job into the database
    const query = `
        INSERT INTO print_jobs 
        (subject, private, discussed, description, weight, length, width, height, file_name, file_data, user_id) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    // Execute the query
    db.query(
        query,
        [subject, private, discussed, description, weight, length, width, height, fileName, fileData, userId],
        (err, result) => {
            if (err) {
                console.error('Error saving print job:', err); // Log the error
                return res.status(500).json({ error: 'Error saving print job' });
            }

            // Return success response
            res.status(201).json({
                message: 'Print job created successfully',
                jobId: result.insertId
            });
        }
    );
});

app.get('/api/print_jobs', requireLogin, (req, res) => {
    const userId = req.session.user.id;

    const query = 'SELECT * FROM print_jobs WHERE user_id = ?';
    db.query(query, [userId], (err, results) => {
        if (err) {
            console.error('Error fetching print jobs:', err);
            return res.status(500).json({ error: 'Could not fetch print jobs' });
        }

        res.status(200).json(results);
    });
});
// ------------------ Schedule API ------------------ //

// POST /api/schedule
app.post('/api/schedule', (req, res) => {
    const { printerId, fileName, subject, startTime, endTime, status, printJobId } = req.body;

    console.log('Received Times (UTC):', startTime, endTime); // Debugging

    if (!printerId || !fileName || !subject || !startTime || !endTime || !status || !printJobId) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    // Save the schedule
    const scheduleQuery = `
        INSERT INTO schedule (printer_id, file_name, subject, start_time, end_time, status)
        VALUES (?, ?, ?, ?, ?, ?)
    `;

    db.query(scheduleQuery, [printerId, fileName, subject, startTime, endTime, status || 'pending'], (err, results) => {
        if (err) {
            console.error('Error saving the schedule:', err);
            return res.status(500).json({ error: 'Could not save the schedule' });
        }

        const scheduleId = results.insertId; // Get the ID of the newly created schedule

        // Update the print_job with the schedule_id
        const updatePrintJobQuery = `
            UPDATE print_jobs
            SET schedule_id = ?, printer_id = ?, start_time = ?, end_time = ?
            WHERE id = ?
        `;

        db.query(updatePrintJobQuery, [scheduleId, printerId, startTime, endTime, printJobId], (err, results) => {
            if (err) {
                console.error('Error updating print job:', err);
                return res.status(500).json({ error: 'Could not update print job' });
            }

            console.log('Schedule saved and print job updated:', { scheduleId, printJobId }); // Debugging
            res.status(200).json({ message: 'Schedule saved successfully', scheduleId });
        });
    });
});

// GET /api/schedule/:printerId
app.get('/api/schedule/:printerId', (req, res) => {
    const printerId = req.params.printerId;

    const query = `
        SELECT file_name, subject, start_time, end_time, status
        FROM schedule 
        WHERE printer_id = ?
    `;

    db.query(query, [printerId], (err, results) => {
        if (err) {
            console.error('Error fetching schedule data:', err);
            return res.status(500).json({ error: 'Could not fetch schedule data' });
        }

        console.log('Fetched Times (UTC):', results); // Debugging

        // Return the events in the format FullCalendar expects
        const events = results.map(event => ({
            file_name: event.file_name,
            subject: event.subject,
            start_time: event.start_time, // UTC time
            end_time: event.end_time // UTC time
        }));

        res.status(200).json(events);
    });
});

// GET /api/print_jobs/latest
app.get('/api/print_jobs/latest', (req, res) => {
    const query = `SELECT * FROM print_jobs ORDER BY created_at DESC LIMIT 1`;

    db.query(query, (err, results) => {
        if (err) {
            console.error('Error fetching latest print job:', err);
            return res.status(500).json({ error: 'Error fetching latest print job' });
        }

        if (results.length === 0) {
            return res.status(404).json({ error: 'No print jobs found' });
        }

        res.status(200).json(results[0]);
    });
});
// GET /api/print_jobs/:printerId
app.get('/api/print_jobs/:printerId', (req, res) => {
    const printerId = req.params.printerId;

    const query = `
        SELECT subject
        FROM print_jobs
        WHERE printer_id = ?
    `;

    db.query(query, [printerId], (err, results) => {
        if (err) {
            console.error('Error fetching print job:', err);
            return res.status(500).json({ error: 'Could not fetch print job' });
        }

        if (results.length === 0) {
            return res.status(404).json({ error: 'Print job not found' });
        }

        const printJob = results[0];
        res.status(200).json(printJob);
    });
});




// ------------------ Start de server ------------------ //

app.listen(port, '0.0.0.0', () => {
    console.log(`Server is listening on port ${port}`);
});
