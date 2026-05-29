backend/
├── server.js                 # Main entry point
├── package.json              # Dependencies
├── .env                      # Environment variables
├── config/
│   ├── db.js                 # MongoDB connection
│   └── firebase.js           # Firebase admin config
├── middleware/
│   ├── auth.js               # JWT verification
│   └── upload.js             # Image upload (multer)
├── models/
│   ├── User.js               # User schema
│   ├── Equipment.js          # Equipment schema
│   ├── Produce.js            # Produce listing schema
│   ├── Booking.js            # Rental/Order booking schema
│   └── Rating.js             # Ratings schema
├── routes/
│   ├── auth.js               # Authentication routes
│   ├── users.js              # User CRUD
│   ├── equipment.js          # Equipment CRUD
│   ├── produce.js            # Produce listing CRUD
│   ├── bookings.js           # Booking management
│   └── dashboard.js          # Dashboard stats
├── controllers/
│   ├── authController.js
│   ├── equipmentController.js
│   ├── produceController.js
│   └── bookingController.js
└── uploads/                  # Image uploads folder
