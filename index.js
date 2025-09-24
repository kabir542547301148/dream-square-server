const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const admin = require("firebase-admin");

dotenv.config();


// stripe

const stripe = require('stripe')(process.env.PAYMENT_GATEWAY_KEY);
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
        const paymentsCollection = db.collection('payments');



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






        app.get("/properties", async (req, res) => {
            try {
                const { email } = req.query;
                let query = {};

                if (email) {
                    // Show ALL properties for that agent
                    query.agentEmail = email;
                } else {
                    // Show only verified for public
                    query.status = "verified";
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

        // ✅ Admin: Get ALL properties (any status)
        app.get("/admin/properties", async (req, res) => {
            try {
                const properties = await propertiesCollection.find().sort({ createdAt: -1 }).toArray();
                res.send(properties);
            } catch (err) {
                res.status(500).send({
                    message: "Internal Server Error",
                    error: err.message,
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




        // 1️⃣ Add a new review
        app.post("/reviews/:propertyId", async (req, res) => {
            try {
                const { propertyId } = req.params;
                const { userId, name, text } = req.body;

                if (!userId || !name || !text) {
                    return res.status(400).json({ message: "Missing required fields" });
                }

                const newReview = {
                    reviewId: new ObjectId().toString(), // ✅ unique ID
                    propertyId,
                    userId,
                    name,
                    text,
                    createdAt: new Date(),
                };

                const result = await reviewsCollection.insertOne(newReview);

                res.json({ message: "Review added successfully", review: newReview });
            } catch (err) {
                console.error(err);
                res.status(500).json({ message: "Server error" });
            }
        });



        // Get all reviews
        app.get("/reviews", async (req, res) => {
            try {
                const allReviews = await reviewsCollection.find().toArray();
                res.json(allReviews);
            } catch (err) {
                console.error(err);
                res.status(500).json({ message: "Server error" });
            }
        });


        // 2️⃣ Get all reviews of a user
        app.get("/reviews/:userEmail", async (req, res) => {
            try {
                const { userEmail } = req.params;

                const userReviews = await reviewsCollection
                    .find({ userId: userEmail })
                    .toArray();

                res.json(userReviews);
            } catch (err) {
                console.error(err);
                res.status(500).json({ message: "Server error" });
            }
        });


        // ✅ Update review status (approve/reject)
        app.patch("/reviews/:id/status", async (req, res) => {
            try {
                const { id } = req.params;
                const { status } = req.body; // "approved" or "rejected"

                if (!["approved", "rejected"].includes(status)) {
                    return res.status(400).send({ message: "Invalid status" });
                }

                const result = await reviewsCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: { status } }
                );

                res.send(result);
            } catch (err) {
                res.status(500).send({ message: "Failed to update review status", error: err.message });
            }
        });






        // // 3️⃣ Delete a review
        app.delete("/reviews/:reviewId", async (req, res) => {
            try {
                const { reviewId } = req.params;

                const result = await reviewsCollection.deleteOne({ reviewId });

                if (result.deletedCount === 0) {
                    return res.status(404).json({ message: "Review not found" });
                }

                res.json({ message: "Review deleted successfully" });
            } catch (err) {
                console.error(err);
                res.status(500).json({ message: "Server error" });
            }
        });








        // ===== POST /offers - submit a new offer =====
        app.post('/offers', async (req, res) => {
            try {
                const {
                    propertyId, title, location, agentName,
                    offerAmount, buyerEmail, buyerName, buyingDate,
                    minPrice, maxPrice
                } = req.body;

                // Validation
                if (!propertyId || !title || !location || !agentName || !offerAmount || !buyerEmail || !buyerName || !buyingDate) {
                    return res.status(400).json({ message: 'Missing required fields' });
                }

                if (offerAmount < minPrice || offerAmount > maxPrice) {
                    return res.status(400).json({ message: `Offer must be between ${minPrice} and ${maxPrice}` });
                }

                // Fetch property from DB
                const property = await propertiesCollection.findOne({ _id: new ObjectId(propertyId) });
                if (!property) return res.status(404).json({ message: "Property not found" });

                const newOffer = {
                    propertyId,
                    title,
                    location,
                    agentName,
                    agentEmail: property.agentEmail,
                    offerAmount,
                    buyerEmail,
                    buyerName,
                    buyingDate,
                    status: 'pending',
                    createdAt: new Date(),
                };

                await offersCollection.insertOne(newOffer);
                res.json({ message: 'Offer submitted successfully', offer: newOffer });

            } catch (err) {
                console.error("Offer error:", err);
                res.status(500).json({ message: 'Server error' });
            }
        });

        // ===== GET /offers - get offers by buyer =====
        app.get("/offers", verifyFBToken, async (req, res) => {
            try {
                const buyerEmail = req.query.buyerEmail;
                if (!buyerEmail) return res.status(400).json({ message: "buyerEmail query parameter required" });

                const offers = await offersCollection.find({ buyerEmail }).sort({ createdAt: -1 }).toArray();

                // Fetch property images
                const propertyIds = offers.map(o => new ObjectId(o.propertyId));
                const properties = await propertiesCollection.find({ _id: { $in: propertyIds } }).toArray();

                // Merge offers with property images
                const merged = offers.map(o => {
                    const prop = properties.find(p => p._id.toString() === o.propertyId);
                    return {
                        ...o,
                        image: prop?.image || null,
                    };
                });

                res.status(200).json(merged);
            } catch (error) {
                console.error(error);
                res.status(500).json({ message: "Failed to fetch offers" });
            }
        });

        // ===== GET /offers/agent/:email - get all offers for agent's properties =====
        app.get("/offers/agent/:email", verifyFBToken, async (req, res) => {
            try {
                const agentEmail = req.params.email;

                const offers = await offersCollection
                    .find({ agentEmail })
                    .sort({ createdAt: -1 })
                    .toArray();

                res.status(200).json(offers);
            } catch (error) {
                console.error("Error fetching agent offers:", error);
                res.status(500).json({ message: "Failed to fetch offers" });
            }
        });

        // ===== PATCH /offers/:id/accept - accept an offer & reject others =====
        app.patch("/offers/:id/accept", async (req, res) => {
            try {
                const { id } = req.params;

                const offer = await offersCollection.findOne({ _id: new ObjectId(id) });
                if (!offer) return res.status(404).send({ message: "Offer not found" });

                // Accept selected offer
                await offersCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: { status: "accepted" } }
                );

                // Reject all other offers for same property
                await offersCollection.updateMany(
                    { propertyId: offer.propertyId, _id: { $ne: new ObjectId(id) } },
                    { $set: { status: "rejected" } }
                );

                res.send({ message: "Offer accepted and others rejected" });
            } catch (error) {
                console.error(error);
                res.status(500).send({ message: "Server error" });
            }
        });

        // ===== PATCH /offers/:id/reject - reject an offer =====
        app.patch("/offers/:id/reject", async (req, res) => {
            try {
                const { id } = req.params;
                const result = await offersCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: { status: "rejected" } }
                );

                if (result.modifiedCount === 0) return res.status(404).send({ message: "Offer not found" });

                res.send({ message: "Offer rejected" });
            } catch (error) {
                console.error(error);
                res.status(500).send({ message: "Server error" });
            }
        });



        app.get("/offers/:id", async (req, res) => {
            try {
                const { id } = req.params;
                const offer = await offersCollection.findOne({ _id: new ObjectId(id) });

                if (!offer) return res.status(404).send({ message: "Offer not found" });
                res.send(offer);
            } catch (error) {
                console.error(error);
                res.status(500).send({ message: "Server error" });
            }
        });

        // app.post("/create-payment-intent", async (req, res) => {
        //     try {
        //         const { amountInCents } = req.body;

        //         if (!amountInCents || amountInCents < 50 || amountInCents > 99999999) {
        //             return res.status(400).send({ error: "Invalid amount" });
        //         }

        //         const paymentIntent = await stripe.paymentIntents.create({
        //             amount: amountInCents,
        //             currency: "usd",
        //             payment_method_types: ["card"],
        //         });

        //         res.send({ clientSecret: paymentIntent.client_secret });
        //     } catch (error) {
        //         console.error("Stripe Error:", error.message);
        //         res.status(500).send({ error: error.message });
        //     }
        // });


        // ✅ Create Payment Intent
        app.post("/create-payment-intent", async (req, res) => {
            try {
                const { amount } = req.body;

                if (!amount || amount < 50) {
                    return res.status(400).send({ error: "Invalid payment amount" });
                }

                const paymentIntent = await stripe.paymentIntents.create({
                    amount,
                    currency: "usd",
                    payment_method_types: ["card"],
                });

                res.send({ clientSecret: paymentIntent.client_secret });
            } catch (error) {
                console.error("Stripe Error:", error.message);
                res.status(500).send({ error: error.message });
            }
        });


        // ✅ Update Project Status
        app.patch("/project-status/:id", async (req, res) => {
            try {
                const { id } = req.params;
                const { transactionId } = req.body;

                if (!transactionId) {
                    return res.status(400).send({ error: "Transaction ID is required" });
                }

                const result = await offersCollection.updateOne(
                    { _id: new ObjectId(id) },
                    {
                        $set: {
                            status: "bought",
                            transactionId,
                        },
                    }
                );

                if (result.modifiedCount > 0) {
                    res.send({ success: true, message: "Project marked as bought" });
                } else {
                    res.status(404).send({ error: "Offer not found or already updated" });
                }
            } catch (error) {
                console.error("Error updating project status:", error.message);
                res.status(500).send({ error: "Failed to update project status" });
            }
        });




        // ✅ Store Payment Info
        app.post("/payments", async (req, res) => {
            try {
                const { offerId, propertyId, email, amount, transactionId, paymentMethod } = req.body;

                console.log("Received payment:", req.body); // DEBUG LOG

                if (!offerId || !propertyId || !email || !amount || !transactionId || !paymentMethod) {
                    return res.status(400).send({ error: "Missing required payment fields" });
                }

                // Ensure amount is a number
                const safeAmount = Number(amount);
                if (isNaN(safeAmount) || safeAmount <= 0) {
                    return res.status(400).send({ error: "Invalid amount" });
                }

                const paymentData = {
                    offerId,
                    propertyId,
                    email,
                    amount: safeAmount,
                    transactionId,
                    paymentMethod,
                    status: "paid",
                    date: new Date(),
                };

                const result = await paymentsCollection.insertOne(paymentData);
                console.log("Inserted payment:", result); // DEBUG LOG

                res.send({ insertedId: result.insertedId });
            } catch (error) {
                console.error("Error saving payment:", error); // Full error
                res.status(500).send({ error: "Failed to save payment" });
            }
        });




        // GET sold properties by agent
    app.get('/payments/agent/:email', async (req, res) => {
    try {
        const { email } = req.params;
        if (!email) return res.status(400).send({ error: 'Agent email is required' });

        // Fetch all payments
        const payments = await paymentsCollection.find({ status: 'paid' }).toArray();

        // Fetch all properties owned by this agent
        const properties = await propertiesCollection.find({ agentEmail: email }).toArray();
        const propertyIds = properties.map(p => p._id.toString());

        // Filter payments where propertyId matches the agent's properties
        const soldPayments = payments.filter(p => propertyIds.includes(p.propertyId));

        res.send(soldPayments);
    } catch (error) {
        console.error('Error fetching sold properties:', error);
        res.status(500).send({ error: 'Failed to fetch sold properties' });
    }
});




        // Store Payment Data










        app.get("/properties/:id", async (req, res) => {
            try {
                const { id } = req.params;

                let property;
                if (ObjectId.isValid(id)) {
                    property = await propertiesCollection.findOne({ _id: new ObjectId(id) });
                }

                // fallback: try plain string _id
                if (!property) {
                    property = await propertiesCollection.findOne({ _id: id });
                }

                if (!property) {
                    return res.status(404).json({ message: "Property not found" });
                }

                res.json(property);
            } catch (err) {
                console.error("Error fetching property:", err);
                res.status(500).json({ message: "Server error" });
            }
        });
        // Add a review for a property
        app.post("/properties/:id/reviews", async (req, res) => {
            try {
                const { id } = req.params;
                const { userId, name, text } = req.body;

                if (!userId || !name || !text) {
                    return res.status(400).json({ message: "Missing fields" });
                }

                const newReview = { userId, name, text };
                const result = await propertiesCollection.findOneAndUpdate(
                    { _id: new ObjectId(id) },
                    { $push: { reviews: newReview } },
                    { returnDocument: "after" }
                );

                if (!result.value) {
                    return res.status(404).json({ message: "Property not found" });
                }

                res.json(newReview);
            } catch (err) {
                console.error("Error adding review:", err);
                res.status(500).json({ message: "Server error" });
            }
        });


















        // Single property by ID
        app.get("/properties/:id", async (req, res) => {
            const id = req.params.id;
            const property = await propertiesCollection.findOne({ _id: new ObjectId(id) });
            if (!property) return res.status(404).send({ message: "Property not found" });
            res.send(property);
        });


        // ✅ Get property by ID


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






