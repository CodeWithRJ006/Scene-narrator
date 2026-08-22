export class VoiceCommand {
  constructor(onTargetSet) {
    this.recognition = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
    this.recognition.continuous = false;
    this.recognition.interimResults = false;
    this.onTargetSet = onTargetSet;

    this.recognition.onresult = (event) => {
      const command = event.results[0][0].transcript.toLowerCase();
      console.log("Voice Command Heard:", command);
      
      // Intent Parser: Look for "find", "where is", "navigate to"
      const triggerWords = ["find", "where is", "locate", "navigate to", "look for"];
      let target = null;
      
      for (const trigger of triggerWords) {
        if (command.includes(trigger)) {
          target = command.split(trigger)[1].trim().replace(/^(the|my|a)\s/, '');
          break;
        }
      }
      if (target) this.onTargetSet(target);
    };
  }

  startListening() {
    this.recognition.start();
  }
}
