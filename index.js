const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const admin = require("firebase-admin");

dotenv.config();
const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Firebase Admin
const serviceAccount = require("./firebase-admin-key.json");
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

// MongoDB URI
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.uhfnere.mongodb.net/?retryWrites=true&w=majority`;

// Create MongoClient
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function run() {
    try {
        await client.connect();
        const db = client.db("realEstateDb");
        const propertiesCollection = db.collection('properties');
        const usersCollection = db.collection('users');
       

        // ============ MIDDLEWARES ============
        const verifyFBToken = async (req, res, next) => {
            const authHeader = req.headers.authorization;
            if (!authHeader) return res.status(401).send({ message: "unauthorized access" });

            const token = authHeader.split(' ')[1];
            if (!token) return res.status(401).send({ message: "unauthorized access" });

            try {
                const decoded = await admin.auth().verifyIdToken(token);
                req.decoded = decoded;
                next();
            } catch (error) {
                return res.status(403).send({ message: "forbidden access" });
            }
        };

        // ============ USER ROUTES ============
        app.post('/users', async (req, res) => {
            const email = req.body.email;
            const userExists = await usersCollection.findOne({ email });
            if (userExists) return res.status(200).send({ message: 'user already exists', inserted: false });
            const result = await usersCollection.insertOne(req.body);
            res.send(result);
        });

        app.get("/users/role/:email", async (req, res) => {
            const email = req.params.email;
            const user = await usersCollection.findOne({ email });
            if (!user) return res.status(404).send({ message: "User not found" });
            res.send({ role: user.role || "user" });
        });
     

        app.get("/users", verifyFBToken, async (req, res) => {
            const users = await usersCollection.find().toArray();
            res.send(users);
        });
      

        app.patch("/users/admin/:id", async (req, res) => {
            const id = req.params.id;
            const result = await usersCollection.updateOne({ _id: new ObjectId(id) }, { $set: { role: "admin" } });
            res.send(result);
        });
        app.patch("/users/admin/:id", async (req, res) => {
            const id = req.params.id;
            const result = await usersCollection.updateOne({ _id: new ObjectId(id) }, { $set: { role: "admin" } });
            res.send(result);
        });

        app.patch("/users/agent/:id", async (req, res) => {
            const id = req.params.id;
            const result = await usersCollection.updateOne({ _id: new ObjectId(id) }, { $set: { role: "agent" } });
            res.send(result);
        });

        app.patch("/users/fraud/:id", async (req, res) => {
            const id = req.params.id;
            const filter = { _id: new ObjectId(id) };
            const result = await usersCollection.updateOne(filter, { $set: { role: "fraud" } });

            const agent = await usersCollection.findOne(filter);
            if (agent?.email) await propertiesCollection.deleteMany({ agentEmail: agent.email });

            res.send(result);
        });

        app.delete("/users/:id", async (req, res) => {
            const id = req.params.id;
            const { email } = req.body;
            const filter = { _id: new ObjectId(id) };
            const result = await usersCollection.deleteOne(filter);

            if (email) {
                try {
                    const userRecord = await admin.auth().getUserByEmail(email);
                    await admin.auth().deleteUser(userRecord.uid);
                } catch (err) {
                    console.log("Firebase delete error:", err.message);
                }
            }
            res.send(result);
        });

        // ============ PROPERTY ROUTES ============
        
        app.post("/properties", async (req, res) => {
            const property = req.body;
            if (!property || Object.keys(property).length === 0) return res.status(400).send({ message: "Property data is required" });

            const user = await usersCollection.findOne({ email: property.agentEmail });
            if (user?.role === "fraud") return res.status(403).send({ message: "Fraud agents cannot add properties" });

            property.createdAt = new Date();
            property.status = "pending";

            const result = await propertiesCollection.insertOne(property);
            res.send(result);
        });

        // Get all properties or user-specific
        app.get("/properties", verifyFBToken, async (req, res) => {
            try {
                const { email } = req.query;
                const query = email ? { agentEmail: email } : {};
                const properties = await propertiesCollection.find(query).toArray();
                res.send(properties);
            } catch (err) {
                res.status(500).send({ message: "Internal Server Error", error: err.message });
            }
        });

        // Update property status
        app.patch("/properties/:id/status", async (req, res) => {
            const { id } = req.params;
            const { status } = req.body;
            if (!["verified", "rejected"].includes(status)) return res.status(400).send({ message: "Invalid status" });

            const result = await propertiesCollection.updateOne({ _id: new ObjectId(id) }, { $set: { status } });
            res.send(result);
        });

        // Delete property
        app.delete("/properties/:id", async (req, res) => {
            const id = req.params.id;
            const result = await propertiesCollection.deleteOne({ _id: new ObjectId(id) });
            res.send(result);
        });

        // Update entire property
        app.put("/properties/:id", async (req, res) => {
            try {
                const id = req.params.id;
                const updatedData = req.body;
                if (!ObjectId.isValid(id)) return res.status(400).send({ message: "Invalid property ID" });

                delete updatedData._id;
                const result = await propertiesCollection.updateOne({ _id: new ObjectId(id) }, { $set: updatedData });

                if (result.matchedCount === 0) return res.status(404).send({ message: "Property not found" });
                res.send({ message: "Property updated successfully" });
            } catch (err) {
                res.status(500).send({ message: "Internal Server Error", error: err.message });
            }
        });




        // Single property by ID
        app.get("/properties/:id", async (req, res) => {
            const id = req.params.id;
            const property = await propertiesCollection.findOne({ _id: new ObjectId(id) });
            if (!property) return res.status(404).send({ message: "Property not found" });
            res.send(property);
        });


        app.get("/advertised-properties", async (req, res) => {
            const advertised = await propertiesCollection
                .find({ isAdvertised: true })
                .toArray();
            res.send(advertised);
        });

        // Ping MongoDB
        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. Successfully connected to MongoDB!");
    } catch (err) {
        console.error("MongoDB connection error:", err);
    }
}

run().catch(console.dir);

// Root route
app.get("/", (req, res) => {
    res.send("🏠DreamSquare Real Estate Server is running...");
});

// Start server
app.listen(port, () => {
    console.log(`🚀 DreamSquare server running on port ${port}`);
});






