#!/bin/bash

cd ~/crypto-bot
git pull
npm install
pm2 restart crypto-bot
