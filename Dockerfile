# Use a lightweight Node.js base image
FROM node:20-alpine

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json to install dependencies
COPY package*.json ./

# Install application dependencies
RUN npm install

# Copy all application files (server.js and config.json)
COPY . .

# The application listens on port 3000
EXPOSE 3000

# Run the application
CMD [ "node", "server.js" ]