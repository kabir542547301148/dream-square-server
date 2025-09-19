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
        const wishlistCollection = db.collection('wishlist');
        const offersCollection = db.collection('offers');
        const reviewsCollection = db.collection('reviews');



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

        app.post("/properties", verifyFBToken, async (req, res) => {
            const property = req.body;
            if (!property || Object.keys(property).length === 0) return res.status(400).send({ message: "Property data is required" });

            const user = await usersCollection.findOne({ email: property.agentEmail });
            if (user?.role === "fraud") return res.status(403).send({ message: "Fraud agents cannot add properties" });

            property.createdAt = new Date();
            property.status = "pending";

            const result = await propertiesCollection.insertOne(property);
            res.send(result);
        });



        // ✅ Get only verified properties (for AllProperties page)
        app.get("/properties", async (req, res) => {
            try {
                const { email } = req.query;
                let query = { status: "verified" }; // ✅ Only fetch verified properties

                if (email) {
                    query.agentEmail = email; // ✅ Get verified properties of specific agent
                }

                const properties = await propertiesCollection.find(query).toArray();
                res.send(properties);
            } catch (err) {
                res.status(500).send({
                    message: "Internal Server Error",
                    error: err.message
                });
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


        // wishlist and reviews route


        // Get property details with reviews
        app.get('/properties/:id', async (req, res) => {
            try {
                const { id } = req.params;
                const property = await propertiesCollection.findOne({ _id: new ObjectId(id) });
                if (!property) return res.status(404).json({ message: 'Property not found' });
                res.json(property);
            } catch (err) {
                console.error(err);
                res.status(500).json({ message: 'Server error' });
            }
        });

        // Add property to wishlist
        // app.post('/wishlist', async (req, res) => {
        //     try {
        //         const { userId, propertyId } = req.body;
        //         if (!userId || !propertyId) return res.status(400).json({ message: 'Missing userId or propertyId' });

        //         // Check if already in wishlist
        //         const exists = await wishlistCollection.findOne({ userId, propertyId });
        //         if (exists) return res.status(400).json({ message: 'Property already in wishlist' });

        //         const result = await wishlistCollection.insertOne({ userId, propertyId });
        //         res.json(result);
        //     } catch (err) {
        //         console.error(err);
        //         res.status(500).json({ message: 'Server error' });
        //     }
        // });


        app.post('/wishlist', async (req, res) => {
            try {
                const { userEmail, propertyId } = req.body;
                if (!userEmail || !propertyId) return res.status(400).json({ message: 'Missing userEmail or propertyId' });

                // Check if already in wishlist
                const exists = await wishlistCollection.findOne({ userEmail, propertyId });
                if (exists) return res.status(400).json({ message: 'Property already in wishlist' });

                const result = await wishlistCollection.insertOne({ userEmail, propertyId });
                res.json(result);
            } catch (err) {
                console.error(err);
                res.status(500).json({ message: 'Server error' });
            }
        });



        // ✅ Get all wishlist properties for a specific user
        app.get('/wishlist/:email', async (req, res) => {
            try {
                const { email } = req.params;
                if (!email) return res.status(400).json({ message: 'Missing user email' });

                // Find wishlist items
                const wishlistItems = await wishlistCollection.find({ userEmail: email }).toArray();

                if (wishlistItems.length === 0) {
                    return res.json([]); // empty wishlist
                }

                // Get propertyIds from wishlist
                const propertyIds = wishlistItems.map(item => new ObjectId(item.propertyId));

                // Find all properties in that wishlist
                const properties = await propertiesCollection.find({ _id: { $in: propertyIds } }).toArray();

                res.json(properties);
            } catch (err) {
                console.error("Wishlist fetch error:", err);
                res.status(500).json({ message: 'Server error' });
            }
        });

        // ✅ Remove property from wishlist
        app.delete('/wishlist/:email/:propertyId', async (req, res) => {
            try {
                const { email, propertyId } = req.params;
                const result = await wishlistCollection.deleteOne({ userEmail: email, propertyId });
                if (result.deletedCount === 0) {
                    return res.status(404).json({ message: 'Wishlist item not found' });
                }
                res.json({ message: 'Removed from wishlist' });
            } catch (err) {
                console.error("Wishlist delete error:", err);
                res.status(500).json({ message: 'Server error' });
            }
        });



        // offeers 

        // Make an offer
        app.post('/offers', async (req, res) => {
            try {
                const { propertyId, title, location, agentName, offerAmount, buyerEmail, buyerName, buyingDate, minPrice, maxPrice, role } = req.body;

                // ✅ Validation


                if (!propertyId || !title || !location || !agentName || !offerAmount || !buyerEmail || !buyerName || !buyingDate) {
                    return res.status(400).json({ message: 'Missing required fields' });
                }

                if (offerAmount < minPrice || offerAmount > maxPrice) {
                    return res.status(400).json({ message: `Offer must be between ${minPrice} and ${maxPrice}` });
                }

                const newOffer = {
                    propertyId,
                    title,
                    location,
                    agentName,
                    offerAmount,
                    buyerEmail,
                    buyerName,
                    buyingDate,
                    status: 'pending',
                    createdAt: new Date(),
                };

                const result = await offersCollection.insertOne(newOffer);

                res.json({ message: 'Offer submitted successfully', offer: newOffer });
            } catch (err) {
                console.error("Offer error:", err);
                res.status(500).json({ message: 'Server error' });
            }
        });


        // GET bought properties for a specific user
        app.get("/offers", verifyFBToken, async (req, res) => {
            try {
                const buyerEmail = req.query.buyerEmail;
                if (!buyerEmail) {
                    return res.status(400).json({ message: "buyerEmail query parameter required" });
                }

                const db = getDb();
                const offers = await db
                    .collection("offers")
                    .find({ buyerEmail })
                    .sort({ createdAt: -1 })
                    .toArray();

                res.status(200).json(offers);
            } catch (error) {
                console.error(error);
                res.status(500).json({ message: "Failed to fetch bought properties" });
            }
        });


        // Get single property by ID
        app.get("/properties/:id", async (req, res) => {
            try {
                const { id } = req.params;

                // validate ObjectId
                if (!ObjectId.isValid(id)) {
                    return res.status(400).json({ message: "Invalid property ID" });
                }

                const property = await propertiesCollection.findOne({ _id: new ObjectId(id) });

                if (!property) {
                    return res.status(404).json({ message: "Property not found" });
                }

                res.json(property); // ✅ return property object
            } catch (err) {
                console.error("Error fetching property:", err);
                res.status(500).json({ message: "Server error" });
            }
        });




        // Add a review for a property
        app.post('/properties/:id/reviews', async (req, res) => {
            try {
                const { id } = req.params;
                const { userId, name, text } = req.body;

                if (!userId || !name || !text) return res.status(400).json({ message: 'Missing fields' });

                const newReview = { userId, name, text };
                const result = await propertiesCollection.findOneAndUpdate(
                    { _id: new ObjectId(id) },
                    { $push: { reviews: newReview } },
                    { returnDocument: 'after' }
                );

                if (!result.value) return res.status(404).json({ message: 'Property not found' });

                res.json(newReview);
            } catch (err) {
                console.error(err);
                res.status(500).json({ message: 'Server error' });
            }
        });





        // Single property by ID
        app.get("/properties/:id", async (req, res) => {
            const id = req.params.id;
            const property = await propertiesCollection.findOne({ _id: new ObjectId(id) });
            if (!property) return res.status(404).send({ message: "Property not found" });
            res.send(property);
        });

        // advertised properties


        app.get("/advertised-properties", async (req, res) => {
            try {
                const verifiedProperties = await propertiesCollection
                    .find({ status: "verified" })
                    .toArray();
                res.send(verifiedProperties);
            } catch (error) {
                console.error("Error fetching verified properties:", error);
                res.status(500).send({ message: "Failed to fetch verified properties" });
            }
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






