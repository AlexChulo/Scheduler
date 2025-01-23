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
    secret: 'geheim',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
}));

const storage = multer.memoryStorage(); // Store files in memory
const upload = multer({ storage });

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

// Login API-endpoint
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;

    // Zoek de gebruiker in de database
    const query = 'SELECT * FROM user WHERE username = ? AND password = ?';
    db.query(query, [username, password], (err, results) => {
        if (err) {
            console.error('Error tijdens inloggen:', err);
            return res.status(500).json({ error: 'Kan niet inloggen' });
        }

        if (results.length === 0) {
            return res.status(401).json({ error: 'Gebruikersnaam of wachtwoord onjuist' });
        }

        // Sla de gebruiker op in de sessie
        req.session.user = results[0];
        res.status(200).json({ 
            message: 'Inloggen gelukt',
            role: results[0].role // Zorg ervoor dat de rol wordt teruggestuurd
        });
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

app.post('/api/print_jobs', upload.single('file'), (req, res) => {
    const {
        subject,
        private,
        discussed,
        description,
        weight,
        length,
        width,
        height,
        printer_id,
        start_time,
        end_time,
        status
    } = req.body;

    const fileData = req.file.buffer; // Binary data of the uploaded file
    const fileName = req.file.originalname; // Original file name

    const query = `
        INSERT INTO print_jobs 
        (subject, private, discussed, description, weight, length, width, height, file_name, file_data, printer_id, start_time, end_time, status) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    db.query(
        query,
        [subject, private, discussed, description, weight, length, width, height, fileName, fileData, printer_id, start_time, end_time, status],
        (err, result) => {
            if (err) {
                console.error('Error saving print job:', err);
                return res.status(500).json({ error: 'Error saving print job' });
            }

            res.status(201).json({
                message: 'Print job created successfully',
                jobId: result.insertId
            });
        }
    );
});

// ------------------ Schedule API ------------------ //

app.post('/api/schedule', (req, res) => {
    const { printerId, fileName, subject, startTime, endTime, status } = req.body;

    if (!printerId || !fileName || !subject || !startTime || !endTime || !status) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const start_time_utc = new Date(startTime).toISOString(); // Convert to UTC
    const end_time_utc = new Date(endTime).toISOString();

    const query = `
        INSERT INTO schedule (printer_id, file_name, subject, start_time, end_time, status)
        VALUES (?, ?, ?, ?, ?, ?)
    `;

    db.query(query, [printerId, fileName, subject, start_time_utc, end_time_utc, status || 'pending'], (err, results) => {
        if (err) {
            console.error('Error saving the schedule:', err);
            return res.status(500).json({ error: 'Could not save the schedule' });
        }

        res.status(200).json({ message: 'Schedule saved successfully', scheduleId: results.insertId });
    });
});



// Fetch events for a specific printer
app.get('/api/schedule/:printerId', (req, res) => {
    const printerId = req.params.printerId;

    const query = `
        SELECT file_name, subject, start_time, end_time , status
        FROM schedule 
        WHERE printer_id = ?
    `;

    db.query(query, [printerId], (err, results) => {
        if (err) {
            console.error('Error fetching schedule data:', err);
            return res.status(500).json({ error: 'Could not fetch schedule data' });
        }

        // Return the events in the format FullCalendar expects
        const events = results.map(event => ({
            file_name: event.file_name,
            subject: event.subject,
            start_time:  new Date(event.start_time).toISOString(),
            end_time: new Date(event.end_time).toISOString(),
        }));
        

        res.status(200).json(events);
    });

});




// ------------------ Start de server ------------------ //

app.listen(port, '0.0.0.0', () => {
    console.log(`Server is listening on port ${port}`);
});
