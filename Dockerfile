FROM node:18-alpine

# Set working directory inside the container
WORKDIR /metaag2o

# Copy the app contents from the correct folder
COPY metaag-2o/ ./

# Install dependencies
RUN npm install

# Optional: build step for production
# RUN npm run build

# Start the app
CMD ["npm", "start"]
