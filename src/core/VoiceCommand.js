export class VoiceCommand {
  constructor(onTargetSet) {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.warn("Speech API not supported.");
      return;
    }
    this.recognition = new SpeechRecognition();
    this.recognition.continuous = false;
    this.recognition.interimResults = false;
    this.onTargetSet = onTargetSet;

    this.recognition.onresult = (event) => {
      const command = event.results[0][0].transcript.toLowerCase();
      console.log("Heard:", command);

      // Check proximity command
      let match = command.match(/set proximity to (\d+)/);
      if (match) {
        return this.onTargetSet({ type: 'PROXIMITY', payload: parseInt(match[1], 10) });
      }

      // Check camera switch
      if (command.includes("switch camera") || command.includes("next camera")) {
        return this.onTargetSet({ type: 'CAMERA', payload: 'next' });
      }

      // Check cloud narration
      if (command.includes("enable cloud narration") || command.includes("start cloud narration")) {
        return this.onTargetSet({ type: 'CLOUD', payload: true });
      }
      if (command.includes("disable cloud narration") || command.includes("stop cloud narration")) {
        return this.onTargetSet({ type: 'CLOUD', payload: false });
      }

      // Check API key clear
      if (command.includes("clear api key") || command.includes("remove api key")) {
        return this.onTargetSet({ type: 'CLEAR_KEY' });
      }

      // Fallback: Target Search
      const triggers = ["find", "where is", "locate", "navigate to"];
      let target = null;
      for (const trigger of triggers) {
        if (command.includes(trigger)) {
          // Extract the object name
          target = command.split(trigger)[1].trim().replace(/^(the|my|a|an)\s/, '');
          break;
        }
      }
      if (target) {
        this.onTargetSet({ type: 'TARGET', payload: target });
      } else {
        this.onTargetSet(null);
      }
    };

    this.recognition.onerror = (e) => {
      console.warn("Speech recognition error:", e);
      this.onTargetSet(null);
    };
    
    this.recognition.onend = () => {
      // Just in case it ends without result or error
    };
  }

  startListening() {
    if(this.recognition) this.recognition.start();
  }
}
