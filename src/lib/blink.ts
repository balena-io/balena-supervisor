import blinking = require('blinking'); // blinking is a 'coffee' module and can only be imported this way
import * as constants from './constants';

const blink = blinking(constants.ledFile);

export default blink;
