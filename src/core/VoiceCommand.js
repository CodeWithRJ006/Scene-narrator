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
      const triggers = ["find", "where is", "locate", "navigate to"];
      let target = null;
      for (const trigger of triggers) {
        if (command.includes(trigger)) {
          // Extract the object name
          target = command.split(trigger)[1].trim().replace(/^(the|my|a|an)\s/, '');
          break;
        }
      }
      if (target) this.onTargetSet(target);
    };
  }

  startListening() {
    if(this.recognition) this.recognition.start();
  }
}
